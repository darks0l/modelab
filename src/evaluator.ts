import type { ModelConfig } from './types.js';
import { get_encoding } from 'tiktoken';

// ── Token estimation ──────────────────────────────────────────────────────────

let _encoder: { encode: (text: string) => Uint32Array } | null = null;

function getEncoder(): { encode: (text: string) => Uint32Array } | null {
  if (_encoder) return _encoder;
  try {
    _encoder = get_encoding('gpt2');
    return _encoder;
  } catch {
    _encoder = null;
    return null;
  }
}

/** Sync-safe token estimate using BPE; falls back to length/4. */
export function estimateTokens(text: string): number {
  const enc = getEncoder();
  if (enc) return enc.encode(text).length;
  return Math.ceil(text.length / 4);
}

export async function estimateTokensAsync(text: string): Promise<number> {
  const enc = getEncoder();
  if (enc) return enc.encode(text).length;
  try {
    const { get_encoding: ge } = await import('tiktoken');
    const e = ge('gpt2');
    _encoder = e;
    return e.encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

export interface CallResult {
  output: string;
  inputTokens: number;
  outputTokens: number;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ── Retry / Rate Limit ───────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;
const STREAM_TIMEOUT_MS = 120_000;

interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class RateLimitTracker {
  // Proactive backoff: driven by server-sent headers (Retry-After, X-RateLimit-Reset, X-RateLimit-Remaining)
  // Stores absolute timestamps (Date.now() at time of setting)
  private proactiveUntil = new Map<string, number>(); // key → wait until Date.now() value

  // Reactive backoff: driven by locally-observed 429s.
  // Uses a fixed countdown so it works correctly with fake timers.
  private reactiveCountdown = new Map<string, number>(); // key → how many more retries to penalize
  private readonly defaultBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(defaultBackoffMs = 10_000, maxBackoffMs = 300_000) {
    this.defaultBackoffMs = defaultBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
  }

  private key(provider: string, model: string): string {
    return `${provider}/${model}`;
  }

  /**
   * Should we wait before sending the next request?
   *
   * Two independent signals:
   * - Proactive (header-driven): server-sent Retry-After / X-RateLimit-Reset hints
   * - Reactive (locally-observed): exponential backoff after a 429 without headers
   *
   * The MAX is used so both signals can coexist without conflicting.
   * For explicit Retry-After headers, proactive dominates.
   * For 429s without headers, reactive kicks in.
   */
  shouldWait(provider: string, model: string): { wait: boolean; waitMs: number } {
    const k = this.key(provider, model);

    // Proactive: server-sent hints — set by parseRateLimitHeaders or record429(with header)
    let proactiveMs = 0;
    const until = this.proactiveUntil.get(k) ?? 0;
    if (until > 0) {
      const remaining = until - Date.now();
      if (remaining > 0) proactiveMs = remaining;
      else this.proactiveUntil.delete(k); // expired
    }

    // Reactive: locally-observed 429 without explicit retry-after
    // Only used when no proactive signal is active — avoids double-penalizing
    let reactiveMs = 0;
    if (proactiveMs === 0) {
      const count = this.reactiveCountdown.get(k) ?? 0;
      if (count > 0) {
        reactiveMs = Math.min(this.defaultBackoffMs * 2 ** (count - 1), this.maxBackoffMs);
      }
    }

    const waitMs = Math.max(proactiveMs, reactiveMs);
    return { wait: waitMs > 0, waitMs };
  }

  /**
   * Record a locally-observed 429. Increments the reactive countdown
   * (so the NEXT shouldWait call returns a penalty) and stores the explicit
   * retry-after if provided.
   */
  record429(provider: string, model: string, retryAfterMs = 0): void {
    const k = this.key(provider, model);

    // Store explicit retry-after as proactive backoff (server-provided value)
    if (retryAfterMs > 0) {
      this.proactiveUntil.set(k, Date.now() + retryAfterMs);
    }

    // Increment reactive countdown (for exponential backoff on repeated 429s)
    const current = this.reactiveCountdown.get(k) ?? 0;
    this.reactiveCountdown.set(k, current + 1);
  }

  recordSuccess(provider: string, model: string): void {
    const k = this.key(provider, model);
    this.proactiveUntil.delete(k);
    this.reactiveCountdown.delete(k);
  }

  /**
   * Parse server-sent rate-limit headers and update proactive backoff.
   */
  parseRateLimitHeaders(provider: string, model: string, headers: Headers): void {
    const k = this.key(provider, model);

    const ra = headers.get('Retry-After');
    if (ra) {
      const secs = parseInt(ra, 10);
      if (!isNaN(secs)) {
        this.proactiveUntil.set(k, Date.now() + secs * 1000);
        return;
      }
    }

    const reset = headers.get('X-RateLimit-Reset');
    if (reset) {
      const resetTs = parseInt(reset, 10) * 1000;
      if (!isNaN(resetTs)) {
        const waitMs = Math.max(0, resetTs - Date.now());
        if (waitMs > 0) this.proactiveUntil.set(k, Date.now() + waitMs);
        return;
      }
    }

    const remaining = headers.get('X-RateLimit-Remaining');
    if (remaining) {
      const rem = parseInt(remaining, 10);
      if (!isNaN(rem) && rem === 0) {
        this.proactiveUntil.set(k, Date.now() + this.defaultBackoffMs);
      }
    }
  }

  reset(): void {
    this.proactiveUntil.clear();
    this.reactiveCountdown.clear();
  }
}

export const rateLimitTracker = new RateLimitTracker();

/** Reset the global rateLimitTracker singleton — used in tests to prevent cross-test pollution. */
export function resetRateLimitTracker(): void {
  rateLimitTracker.reset();
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  opts: Partial<RetryOptions> & { provider?: string; model?: string } = {}
): Promise<Response> {
  const { maxRetries = 3, initialDelayMs = 1000, timeoutMs = DEFAULT_TIMEOUT_MS, signal, provider, model } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (provider && model) {
      const { wait, waitMs } = rateLimitTracker.shouldWait(provider, model);
      if (wait) {
        console.warn(`[modelab:evaluator] Rate-limit cooldown — waiting ${Math.round(waitMs)}ms before ${provider} request`);
        await sleep(waitMs);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const composedSignal = signal ? anySignal(signal, controller.signal) : controller.signal;

    try {
      const res = await fetch(url, { ...options, signal: composedSignal });
      clearTimeout(timer);

      if (res.ok) {
        if (provider && model) {
          rateLimitTracker.parseRateLimitHeaders(provider, model, res.headers);
          rateLimitTracker.recordSuccess(provider, model);
        }
        return res;
      }

      if (res.status === 429) {
        const retryAfterMs = parseRetryAfterHeader(res.headers);

        // Only use reactive backoff (record429) when server provides NO explicit Retry-After.
        // With an explicit Retry-After header we use proactive backoff only.
        if (retryAfterMs === undefined) {
          rateLimitTracker.record429(provider ?? 'unknown', model ?? 'unknown', 0);
        }

        if (attempt < maxRetries) {
          const delay = retryAfterMs !== undefined
            ? retryAfterMs
            : initialDelayMs * 2 ** attempt + Math.random() * 500;
          console.warn(`[modelab:evaluator] 429 — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
          await sleep(delay);
          continue;
        }
      }

      if (attempt < maxRetries && RETRYABLE_STATUS.has(res.status)) {
        const delay = initialDelayMs * 2 ** attempt + Math.random() * 500;
        console.warn(`[modelab:evaluator] ${res.status} — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(delay);
        continue;
      }

      return res;
    } catch (err: unknown) {
      clearTimeout(timer);
      if (attempt < maxRetries && isNetworkError(err)) {
        const delay = initialDelayMs * 2 ** attempt + Math.random() * 500;
        console.warn(`[modelab:evaluator] Network error — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries}): ${err}`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }

  throw new Error('Max retries exceeded');
}

function parseRetryAfterHeader(headers: Headers): number | undefined {
  const ra = headers.get('Retry-After');
  if (!ra) return undefined;
  const secs = parseInt(ra, 10);
  return isNaN(secs) ? undefined : secs * 1000;
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) s.addEventListener('abort', () => controller.abort());
  return controller.signal;
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.name === 'AbortError' ||
      err.name === 'TypeError' ||
      err.message.includes('fetch') ||
      err.message.includes('network') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('ENOTFOUND')
    );
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Public API ────────────────────────────────────────────────────────────────

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
  if (config.provider === 'glm') return callGLM(config, prompt, key);
  if (config.provider === 'openrouter') return callOpenRouter(config, prompt, key);
  return callOpenAI(config, prompt, key);
}

// ── OpenAI ─────────────────────────────────────────────────────────────────

async function callOpenAI(cfg: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = cfg.baseUrl ?? 'https://api.openai.com/v1';
  if (cfg.stream) return streamOpenAI(cfg, baseUrl, cfg.model, apiKey, prompt);

  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: cfg.maxTokens ?? 512,
      temperature: cfg.temperature ?? 0,
      ...(cfg.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  }, { provider: cfg.provider, model: cfg.model });

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
  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxTokens ?? 512, temperature: cfg.temperature ?? 0, stream: true, ...(cfg.jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
  }, { timeoutMs: STREAM_TIMEOUT_MS, provider: cfg.provider, model: cfg.model });

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

async function callAnthropic(cfg: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = cfg.baseUrl ?? 'https://api.anthropic.com/v1';
  if (cfg.stream) return streamAnthropic(cfg, baseUrl, apiKey, prompt);

  const body: Record<string, unknown> = { model: cfg.model, max_tokens: cfg.maxTokens ?? 1024, messages: [{ role: 'user', content: prompt }] };
  if (cfg.jsonMode) body.output = { text: { annotations: true }, content: [{ type: 'text', text: '' }] };
  const res = await fetchWithRetry(`${baseUrl}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { provider: cfg.provider, model: cfg.model });

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
  const body: Record<string, unknown> = { model: cfg.model, max_tokens: cfg.maxTokens ?? 1024, messages: [{ role: 'user', content: prompt }], stream: true };
  const res = await fetchWithRetry(`${baseUrl}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { timeoutMs: STREAM_TIMEOUT_MS, provider: cfg.provider, model: cfg.model });

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

async function callOllama(cfg: ModelConfig, prompt: string): Promise<CallResult> {
  const baseUrl = cfg.baseUrl ?? 'http://localhost:11434';
  const res = await fetchWithRetry(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, prompt, stream: false, options: { temperature: cfg.temperature ?? 0.7, num_predict: cfg.maxTokens ?? 1024 } }),
  }, { provider: cfg.provider, model: cfg.model });

  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);

  const json = await res.json() as { response: string; prompt_eval_count?: number; eval_count?: number };
  return {
    output: json.response ?? '',
    inputTokens: json.prompt_eval_count ?? estimateTokens(prompt),
    outputTokens: json.eval_count ?? estimateTokens(json.response ?? ''),
  };
}

// ── Groq ─────────────────────────────────────────────────────────────────

async function callGroq(cfg: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = cfg.baseUrl ?? 'https://api.groq.com/openai/v1';
  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxTokens ?? 1024, temperature: cfg.temperature ?? 0, ...(cfg.jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
  }, { provider: cfg.provider, model: cfg.model });

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

// ── Gemini ───────────────────────────────────────────────────────────────

async function callGemini(cfg: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  const model = cfg.model.startsWith('models/') ? cfg.model : `models/${cfg.model}`;
  const res = await fetchWithRetry(`${baseUrl}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: cfg.maxTokens ?? 1024, temperature: cfg.temperature ?? 0 } }),
  }, { provider: cfg.provider, model: cfg.model });

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

async function callPerplexity(cfg: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = cfg.baseUrl ?? 'https://api.perplexity.ai';
  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxTokens ?? 1024, temperature: cfg.temperature ?? 0 }),
  }, { provider: cfg.provider, model: cfg.model });

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

// ── MiniMax ───────────────────────────────────────────────────────────────

async function callMinimax(cfg: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = cfg.baseUrl ?? 'https://api.minimax.chat';
  const res = await fetchWithRetry(`${baseUrl}/v1/text/chatcompletion_v2`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxTokens ?? 1024, temperature: cfg.temperature ?? 0 }),
  }, { provider: cfg.provider, model: cfg.model });

  if (!res.ok) throw new Error(`MiniMax error ${res.status}: ${await res.text()}`);

  const json = await res.json() as { choices?: Array<{ messages?: Array<{ content: string }> }> };
  const output = json.choices?.[0]?.messages?.[0]?.content ?? '';
  return { output, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(output) };
}

// ── GLM (智谱AI / Zhipu) ─────────────────────────────────────────────────

async function callGLM(cfg: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = cfg.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4';
  if (cfg.stream) return streamGLM(cfg, baseUrl, apiKey, prompt);

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: cfg.maxTokens ?? 1024,
    temperature: cfg.temperature ?? 0,
  };
  if (cfg.jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { provider: cfg.provider, model: cfg.model });

  if (!res.ok) throw new Error(`GLM error ${res.status}: ${await res.text()}`);

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

async function streamGLM(cfg: ModelConfig, baseUrl: string, apiKey: string, prompt: string): Promise<CallResult> {
  // GLM streaming: add skip: ["data"] to receive proper SSE delta events instead of full objects.
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: cfg.maxTokens ?? 1024,
    temperature: cfg.temperature ?? 0,
    stream: true,
    stream_options: { include_usage: true },
    skip: ['data'],
  };
  if (cfg.jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { timeoutMs: STREAM_TIMEOUT_MS, provider: cfg.provider, model: cfg.model });

  if (!res.ok) throw new Error(`GLM error ${res.status}`);
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

// ── OpenRouter ────────────────────────────────────────────────────────────

async function callOpenRouter(cfg: ModelConfig, prompt: string, apiKey: string): Promise<CallResult> {
  const baseUrl = cfg.baseUrl ?? 'https://openrouter.ai/api/v1';
  if (cfg.stream) return streamOpenAI(cfg, baseUrl, cfg.model, apiKey, prompt);

  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/darks0l/modelab', 'X-Title': 'modelab' },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxTokens ?? 1024, temperature: cfg.temperature ?? 0, ...(cfg.jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
  }, { provider: cfg.provider, model: cfg.model });

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
    glm: 'GLM_API_KEY',
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
