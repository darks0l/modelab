import type { ModelConfig } from './types.js';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface CallResult {
  output: string;
  inputTokens: number;
  outputTokens: number;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function callModel(config: ModelConfig, prompt: string): Promise<string> {
  const result = await callModelFull(config, prompt);
  return result.output;
}

export async function callModelFull(config: ModelConfig, prompt: string, apiKey?: string): Promise<CallResult> {
  const key = apiKey ?? getApiKey(config.provider);
  if (config.provider === 'ollama') return callOllama(config, prompt);
  if (config.provider === 'anthropic') return callAnthropic(config, prompt, key);
  if (config.provider === 'groq') return callGroq(config, prompt, key);
  if (config.provider === 'gemini') return callGemini(config, prompt, key);
  if (config.provider === 'perplexity') return callPerplexity(config, prompt, key);
  if (config.provider === 'minimax') return callMinimax(config, prompt, key);
  if (config.provider === 'openrouter') return callOpenRouter(config, prompt, key);
  return callOpenAI(config, prompt, key);
}

// ── OpenAI ─────────────────────────────────────────────────────────────────

async function callOpenAI(config: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  if (config.stream) return streamOpenAI(config, baseUrl, config.model, apiKey, prompt);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: config.maxTokens ?? 512,
      temperature: config.temperature ?? 0,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);

  const json = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  return {
    output: json.choices[0]?.message?.content ?? '',
    inputTokens: json.usage?.prompt_tokens ?? estimateTokens(prompt),
    outputTokens: json.usage?.completion_tokens ?? 0,
    usage: json.usage,
  };
}

async function streamOpenAI(cfg: ModelConfig, baseUrl: string, model: string, apiKey: string, prompt: string): Promise<CallResult> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxTokens ?? 512, temperature: cfg.temperature ?? 0, stream: true }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
  if (!res.body) throw new Error('No response body');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let output = '';
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    done = d;
    if (value) {
      const chunk = dec.decode(value, { stream: !done });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { done = true; break; }
        try {
          const p = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const content = p.choices?.[0]?.delta?.content;
          if (content) { output += content; cfg.stream!(content); }
        } catch { /* skip */ }
      }
    }
  }
  return { output, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(output) };
}

// ── Anthropic ──────────────────────────────────────────────────────────────

async function callAnthropic(config: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';
  if (config.stream) return streamAnthropic(config, baseUrl, apiKey, prompt);

  const res = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, max_tokens: config.maxTokens ?? 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);

  const json = await res.json() as {
    content: Array<{ text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };

  return {
    output: json.content[0]?.text ?? '',
    inputTokens: json.usage?.input_tokens ?? estimateTokens(prompt),
    outputTokens: json.usage?.output_tokens ?? 0,
  };
}

async function streamAnthropic(cfg: ModelConfig, baseUrl: string, apiKey: string, prompt: string): Promise<CallResult> {
  const res = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, max_tokens: cfg.maxTokens ?? 1024, messages: [{ role: 'user', content: prompt }], stream: true }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}`);
  if (!res.body) throw new Error('No response body');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let output = '';
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    done = d;
    if (value) {
      const chunk = dec.decode(value, { stream: !done });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { done = true; break; }
        try {
          const p = JSON.parse(data) as { type?: string; text?: string; delta?: { text?: string } };
          const text = p.type === 'content_block' && 'text' in p ? p.text : p.delta?.text;
          if (text) { output += text; cfg.stream!(text); }
        } catch { /* skip */ }
      }
    }
  }
  return { output, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(output) };
}

// ── Ollama ────────────────────────────────────────────────────────────────

async function callOllama(config: ModelConfig, prompt: string): Promise<CallResult> {
  const baseUrl = config.baseUrl ?? 'http://localhost:11434';
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, prompt, stream: false, options: { temperature: config.temperature ?? 0.7, num_predict: config.maxTokens ?? 1024 } }),
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);

  const json = await res.json() as { response: string; prompt_eval_count?: number; eval_count?: number };
  return {
    output: json.response ?? '',
    inputTokens: json.prompt_eval_count ?? estimateTokens(prompt),
    outputTokens: json.eval_count ?? estimateTokens(json.response ?? ''),
  };
}

// ── Groq ──────────────────────────────────────────────────────────────────

async function callGroq(config: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = config.baseUrl ?? 'https://api.groq.com/openai/v1';
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], max_tokens: config.maxTokens ?? 1024, temperature: config.temperature ?? 0 }),
  });
  if (!res.ok) throw new Error(`Groq error ${res.status}: ${await res.text()}`);

  const json = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  return {
    output: json.choices[0]?.message?.content ?? '',
    inputTokens: json.usage?.prompt_tokens ?? estimateTokens(prompt),
    outputTokens: json.usage?.completion_tokens ?? 0,
    usage: json.usage,
  };
}

// ── Gemini ────────────────────────────────────────────────────────────────

async function callGemini(config: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  const model = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
  const res = await fetch(`${baseUrl}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: config.maxTokens ?? 1024, temperature: config.temperature ?? 0 } }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);

  const json = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };

  const output = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return {
    output,
    inputTokens: json.usageMetadata?.promptTokenCount ?? estimateTokens(prompt),
    outputTokens: json.usageMetadata?.candidatesTokenCount ?? estimateTokens(output),
  };
}

// ── Perplexity ────────────────────────────────────────────────────────────

async function callPerplexity(config: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = config.baseUrl ?? 'https://api.perplexity.ai';
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], max_tokens: config.maxTokens ?? 1024, temperature: config.temperature ?? 0 }),
  });
  if (!res.ok) throw new Error(`Perplexity error ${res.status}: ${await res.text()}`);

  const json = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  return {
    output: json.choices[0]?.message?.content ?? '',
    inputTokens: json.usage?.prompt_tokens ?? estimateTokens(prompt),
    outputTokens: json.usage?.completion_tokens ?? 0,
    usage: json.usage,
  };
}

// ── MiniMax ──────────────────────────────────────────────────────────────

async function callMinimax(config: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = config.baseUrl ?? 'https://api.minimax.chat';
  const res = await fetch(`${baseUrl}/v1/text/chatcompletion_v2`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], max_tokens: config.maxTokens ?? 1024, temperature: config.temperature ?? 0 }),
  });
  if (!res.ok) throw new Error(`MiniMax error ${res.status}: ${await res.text()}`);

  const json = await res.json() as { choices?: Array<{ messages?: Array<{ content: string }> }> };
  const output = json.choices?.[0]?.messages?.[0]?.content ?? '';
  return { output, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(output) };
}

// ── OpenRouter ────────────────────────────────────────────────────────────

async function callOpenRouter(config: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
  if (config.stream) return streamOpenAI(config, baseUrl, config.model, apiKey, prompt);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/darks0l/modelab', 'X-Title': 'modelab' },
    body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], max_tokens: config.maxTokens ?? 1024, temperature: config.temperature ?? 0 }),
  });
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);

  const json = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  return {
    output: json.choices[0]?.message?.content ?? '',
    inputTokens: json.usage?.prompt_tokens ?? estimateTokens(prompt),
    outputTokens: json.usage?.completion_tokens ?? 0,
    usage: json.usage,
  };
}

// ── API Key resolution ────────────────────────────────────────────────────

function getApiKey(provider: string): string {
  const env: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    minimax: 'MINIMAX_API_KEY',
    groq: 'GROQ_API_KEY',
    gemini: 'GEMINI_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
  };
  const varName = env[provider];
  if (varName) {
    const k = process.env[varName];
    if (!k) throw new Error(`${varName} not set`);
    return k;
  }
  if (provider === 'openrouter') {
    const k = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!k) throw new Error('OPENROUTER_API_KEY or OPENAI_API_KEY not set');
    return k;
  }
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error('OPENAI_API_KEY not set');
  return k;
}
