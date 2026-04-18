import type { ModelConfig } from './types.js';
import { get_encoding } from 'tiktoken';

/**
 * Token estimator backed by tiktoken's gpt2 encoder — accurate BPE tokenization.
 * Lazy-initialized on first call; falls back to length/4 if tiktoken fails to load.
 * The sync fallback is used until the async encoder is ready (first few ms).
 */
let _encoder: { encode: (text: string) => Uint32Array } | null = null;
let _encoderReady = false;

function getEncoder(): { encode: (text: string) => Uint32Array } | null {
  if (_encoder) return _encoder;
  try {
    _encoder = get_encoding('gpt2');
    _encoderReady = true;
    return _encoder;
  } catch {
    _encoder = null;
    return null;
  }
}

/** Synchronous token estimate — uses BPE when available, length/4 as fallback.
 * This is the primary export; it is sync-safe and fast (< 1ms per call once warm).
 */
export function estimateTokens(text: string): number {
  const enc = getEncoder();
  if (enc) return enc.encode(text).length;
  return Math.ceil(text.length / 4);
}

/** Async token estimate — always returns an accurate BPE count.
 * Use this in async contexts where you want the best accuracy from the first call.
 */
export async function estimateTokensAsync(text: string): Promise<number> {
  const enc = getEncoder();
  if (enc) return enc.encode(text).length;
  // tiktoken not yet loaded — do a sync init attempt then count
  try {
    const { get_encoding: ge } = await import('tiktoken');
    const e = ge('gpt2');
    _encoder = e;
    _encoderReady = true;
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

// ── Retry + Timeout helpers ──────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000; // 60s
const STREAM_TIMEOUT_MS = 120_000; // 120s

interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Proactive rate limit tracker — prevents wasted requests by waiting before
 * sending when a provider has recently rate-limited us.
 *
 * Tracks per-(provider, model) last-429 timestamp and applies exponential
 * backoff before the next request. Also parses standard rate-limit headers
 * (X-RateLimit-*, Retry-After) when available.
 */
export class RateLimitTracker {
  private last429 = new Map<string, number>(); // key → last 429 timestamp (ms)
  private lastRetryAfter = new Map<string, number>(); // key → explicit retry-after ms
  private readonly defaultBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(defaultBackoffMs = 10_000, maxBackoffMs = 300_000) {
    this.defaultBackoffMs = defaultBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
  }

  /** key = "provider/model" */
  private key(provider: string, model: string): string {
    return `${provider}/${model}`;
  }

  /**
   * Called before a request. Returns true if we should wait first (rate limited recently).
   * Use the returned `waitMs` as the delay before sending.
   */
  shouldWait(provider: string, model: string): { wait: boolean; waitMs: number } {
    const k = this.key(provider, model);
    const last429At = this.last429.get(k) ?? 0;
    const explicitMs = this.lastRetryAfter.get(k) ?? 0;

    // Exponential backoff: 10s base, doubling per recent 429, up to max
    const recent429Penalty = last429At > 0
      ? Math.min(this.defaultBackoffMs * 2 ** this.getRecent429Count(k), this.maxBackoffMs)
      : 0;

    const waitMs = Math.max(recent429Penalty, explicitMs);

    return { wait: waitMs > 0, waitMs };
  }

  /**
   * Call after receiving a 429 response. Updates backoff state.
   * @param retryAfterMs - parsed Retry-After header if present, otherwise 0
   */
  record429(provider: string, model: string, retryAfterMs = 0): void {
    const k = this.key(provider, model);
    const now = Date.now();
    this.last429.set(k, now);
    if (retryAfterMs > 0) this.lastRetryAfter.set(k, retryAfterMs);
    else this.lastRetryAfter.delete(k);
  }

  /**
   * Call after a successful request to a provider — clears the 429 penalty.
   */
  recordSuccess(provider: string, model: string): void {
    const k = this.key(provider, model);
    this.last429.delete(k);
    this.lastRetryAfter.delete(k);
  }

  /**
   * Parse rate-limit headers from a successful response and update backoff state.
   * Supports: Retry-After, X-RateLimit-Reset, X-RateLimit-Remaining, RateLimit-Limit
   */
  parseRateLimitHeaders(provider: string, model: string, headers: Headers): void {
    const k = this.key(provider, model);

    // Explicit Retry-After takes priority
    const ra = headers.get('Retry-After');
    if (ra) {
      const secs = parseInt(ra, 10);
      if (!isNaN(secs)) {
        this.lastRetryAfter.set(k, secs * 1000);
        return;
      }
    }

    // X-RateLimit-Reset: Unix timestamp (seconds)
    const reset = headers.get('X-RateLimit-Reset');
    if (reset) {
      const resetTs = parseInt(reset, 10) * 1000;
      if (!isNaN(resetTs)) {
        const waitMs = Math.max(0, resetTs - Date.now());
        if (waitMs > 0) this.lastRetryAfter.set(k, waitMs);
        return;
      }
    }

    // X-RateLimit-Remaining + known window size → estimate reset time
    const remaining = headers.get('X-RateLimit-Remaining');
    if (remaining) {
      const rem = parseInt(remaining, 10);
      if (!isNaN(rem) && rem === 0) {
        // No remaining requests — back off for default window
        this.lastRetryAfter.set(k, this.defaultBackoffMs);
      }
    }
  }

  /** Count 429s in the last 5 minutes for a given provider */
  private getRecent429Count(k: string): number {
    const cutoff = Date.now() - 5 * 60 * 1000;
    // We only store the last 429 time, so we approximate:
    // if last429 < 5min ago → count = 1, else 0
    const last = this.last429.get(k) ?? 0;
    return last > cutoff ? 1 : 0;
  }

  /** Clear all tracking state */
  reset(): void {
    this.last429.clear();
    this.lastRetryAfter.clear();
  }
}

/** Singleton shared across all evaluator calls — import and reuse */
export const rateLimitTracker = new RateLimitTracker();

/**
 * Fetch with timeout + exponential backoff retry + proactive rate-limit backoff.
 *
 * Proactive backoff: before each attempt, checks rateLimitTracker and waits
 * if the provider was recently rate-limited. After a 429, records it for future
 * proactive avoidance.
 *
 * @param provider - e.g. 'openai', 'anthropic' — used for rate-limit tracking
 * @param model    - model name — used as the second key in rate-limit tracking
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  opts: Partial<RetryOptions> & { provider?: string; model?: string } = {}
): Promise<Response> {
  const { maxRetries = 3, initialDelayMs = 1000, timeoutMs = DEFAULT_TIMEOUT_MS, signal, provider, model } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // ── Proactive backoff: wait if provider was recently rate-limited ──
    if (provider && model) {
      const { wait, waitMs } = rateLimitTracker.shouldWait(provider, model);
      if (wait) {
        console.warn(`[modelab:evaluator] Rate-limit cooldown — waiting ${Math.round(waitMs)}ms before ${provider} request`);
        await sleep(waitMs);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const composedSignal = signal
      ? anySignal(signal, controller.signal)
      : controller.signal;

    try {
      const res = await fetch(url, { ...options, signal: composedSignal });
      clearTimeout(timer);

      if (res.ok) {
        // Parse rate-limit headers — updates wait time if approaching limit.
        // Also call recordSuccess to clear any outstanding 429 backoff;
        // this is safe because a 2xx means the request succeeded.
        if (provider && model) {
          rateLimitTracker.parseRateLimitHeaders(provider, model, res.headers);
          rateLimitTracker.recordSuccess(provider, model);
        }
        return res;
      }

      // ── Reactive 429 handling ──────────────────────────────────────
      if (res.status === 429) {
        const retryAfterMs = parseRetryAfterHeader(res.headers);
        rateLimitTracker.record429(provider ?? 'unknown', model ?? 'unknown', retryAfterMs);

        if (attempt < maxRetries) {
          const delay = retryAfterMs
            ?? initialDelayMs * 2 ** attempt + Math.random() * 500;
          console.warn(`[modelab:evaluator] 429 — recording and retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
          await sleep(delay);
          continue;
        }
      }

      // ── Other retryable errors ─────────────────────────────────────
      if (attempt < maxRetries && RETRYABLE_STATUS.has(res.status)) {
        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : initialDelayMs * 2 ** attempt + Math.random() * 500;
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

  // Should not reach here, but satisfy TypeScript
  throw new Error('Max retries exceeded');
}

/** Parse Retry-After header into milliseconds, or 0 if absent/invalid */
function parseRetryAfterHeader(headers: Headers): number | undefined {
  const ra = headers.get('Retry-After');
  if (!ra) return undefined;
  const secs = parseInt(ra, 10);
  return isNaN(secs) ? undefined : secs * 1000;
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    s.addEventListener('abort', () => controller.abort());
  }
  return controller.signal;
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.name === 'AbortError' ||
      err.name === 'TypeError' || // network failure
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

/**
 * Call a GLM model via the BigModel API (OpenAI-compatible endpoint).
 * GLM-4 series supports JSON mode, function calling, and streaming.
 * Docs: https://open.bigmodel.cn/dev/api#chatglm
 */
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
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: cfg.maxTokens ?? 1024,
    temperature: cfg.temperature ?? 0,
    stream: true,
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
