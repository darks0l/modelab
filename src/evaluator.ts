import type { ModelConfig } from './types.js';
import { calcCost } from './router.js';

interface EvalResponse {
  score: number;
  reasoning: string;
}

/**
 * Simple LLM judge — sends output + question to a configured eval model
 * and parses a 0–10 score from the response.
 *
 * Prompt: structured rubric asking the model to score on
 *   clarity (0–3), correctness (0–4), completeness (0–3)
 */
export async function evaluate(
  output: string,
  question: string,
  evalModel: ModelConfig
): Promise<number> {
  const prompt = `You are an impartial evaluator. Score the following answer to the question.

Question: ${question}

Answer:
${output}

Respond ONLY with a JSON object: {"score": <0-10>, "reasoning": "<1-sentence>"}
Score rubric:
- 0-3: clarity — is the answer clear and readable?
- 0-4: correctness — is the answer factually/reasoningly sound?
- 0-3: completeness — does it fully address the question?

Return only the JSON. No markdown.`;

  try {
    const response = await callModel(evalModel, prompt);
    const parsed = JSON.parse(response) as EvalResponse;
    const score = Math.max(0, Math.min(10, parsed.score));
    return Math.round(score * 10) / 10;
  } catch (err) {
    console.warn('[modelab:evaluator] eval failed:', err);
    return 0;
  }
}

export async function callModel(config: ModelConfig, prompt: string): Promise<string> {
  const apiKey = config.apiKey ?? getApiKey(config.provider);

  if (config.provider === 'ollama') {
    return callOllama(config, prompt);
  }
  if (config.provider === 'anthropic') {
    return callAnthropic(config, prompt, apiKey);
  }
  // Default: OpenAI / OpenAI-compatible
  return callOpenAI(config, prompt, apiKey);
}

function getApiKey(provider: string): string {
  if (provider === 'anthropic') {
    const k = process.env.ANTHROPIC_API_KEY;
    if (!k) throw new Error('ANTHROPIC_API_KEY not set');
    return k;
  }
  // openai / openrouter
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error('OPENAI_API_KEY not set');
  return k;
}

async function callOpenAI(config: ModelConfig, prompt: string, apiKey: string): Promise<string> {
  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  const model = config.model.startsWith('anthropic/')
    ? config.model.replace('anthropic/', '')
    : config.model;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: config.maxTokens ?? 512,
      temperature: config.temperature ?? 0,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  const json = await res.json() as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]?.message?.content ?? '';
}

async function callAnthropic(config: ModelConfig, prompt: string, apiKey: string): Promise<string> {
  const baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';
  const model = config.model;

  const res = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: config.maxTokens ?? 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const json = await res.json() as { content: Array<{ text: string }> };
  return json.content[0]?.text ?? '';
}

async function callOllama(config: ModelConfig, prompt: string): Promise<string> {
  const baseUrl = config.baseUrl ?? 'http://localhost:11434';

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      prompt,
      stream: false,
      options: {
        temperature: config.temperature ?? 0.7,
        num_predict: config.maxTokens ?? 1024,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }

  const json = await res.json() as { response: string };
  return json.response ?? '';
}
