/**
 * Evaluator unit tests.
 *
 * Tests cover:
 * - Token estimation (tiktoken / fallback)
 * - RateLimitTracker backoff + header parsing
 * - fetchWithRetry timeout / exponential backoff / retryable status codes
 * - callModelFull provider routing
 *
 * Uses vi.mock + fake timers to avoid real network I/O.
 * Always resets the global rateLimitTracker singleton between tests.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { ModelConfig } from '../src/types.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeBodyStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

const OPENAI_MODEL: ModelConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  costPerMillionInput: 0.15,
  costPerMillionOutput: 0.60,
};

const ANTHROPIC_MODEL: ModelConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  costPerMillionInput: 3,
  costPerMillionOutput: 15,
};

const OLLAMA_MODEL: ModelConfig = {
  provider: 'ollama',
  model: 'qwen3-coder',
  baseUrl: 'http://localhost:11434',
  costPerMillionInput: 0,
  costPerMillionOutput: 0,
};

const GLM_MODEL: ModelConfig = {
  provider: 'glm',
  model: 'glm-4.7',
  costPerMillionInput: 0.1,
  costPerMillionOutput: 0.1,
};

// ── Token estimation ─────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns a positive number for any non-empty string', async () => {
    const { estimateTokens } = await import('../src/evaluator.js');
    expect(estimateTokens('hello')).toBeGreaterThan(0);
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
  });

  it('scales roughly with text length', async () => {
    const { estimateTokens } = await import('../src/evaluator.js');
    const short = estimateTokens('hi');
    const long = estimateTokens('The quick brown fox jumps over the lazy dog.');
    expect(long).toBeGreaterThan(short);
  });

  it('returns a finite number for very long strings', async () => {
    const { estimateTokens } = await import('../src/evaluator.js');
    const long = 'word '.repeat(10_000);
    const count = estimateTokens(long);
    expect(Number.isFinite(count)).toBe(true);
    expect(count).toBeGreaterThan(0);
  });
});

// ── RateLimitTracker ─────────────────────────────────────────────────────────

describe('RateLimitTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Reset the global singleton to prevent cross-test pollution
    const { resetRateLimitTracker } = await import('../src/evaluator.js');
    resetRateLimitTracker();
  });

  it('returns wait=false when no prior 429', async () => {
    const { RateLimitTracker } = await import('../src/evaluator.js');
    const tracker = new RateLimitTracker(10_000, 300_000);
    const result = tracker.shouldWait('openai', 'gpt-4o-mini');
    expect(result.wait).toBe(false);
    expect(result.waitMs).toBe(0);
  });

  it('returns wait=true after recording a 429', async () => {
    const { RateLimitTracker } = await import('../src/evaluator.js');
    const tracker = new RateLimitTracker(10_000, 300_000);
    tracker.record429('openai', 'gpt-4o-mini', 0);
    const { wait, waitMs } = tracker.shouldWait('openai', 'gpt-4o-mini');
    expect(wait).toBe(true);
    expect(waitMs).toBeGreaterThan(0);
  });

  it('respects explicit Retry-After header value', async () => {
    const { RateLimitTracker } = await import('../src/evaluator.js');
    const tracker = new RateLimitTracker(10_000, 300_000);
    tracker.record429('anthropic', 'claude-sonnet-4-6', 30_000);
    const { wait, waitMs } = tracker.shouldWait('anthropic', 'claude-sonnet-4-6');
    expect(wait).toBe(true);
    expect(waitMs).toBe(30_000);
  });

  it('clears backoff on recordSuccess', async () => {
    const { RateLimitTracker } = await import('../src/evaluator.js');
    const tracker = new RateLimitTracker(10_000, 300_000);
    tracker.record429('openai', 'gpt-4o-mini', 0);
    expect(tracker.shouldWait('openai', 'gpt-4o-mini').wait).toBe(true);
    tracker.recordSuccess('openai', 'gpt-4o-mini');
    expect(tracker.shouldWait('openai', 'gpt-4o-mini').wait).toBe(false);
  });

  it('parses X-RateLimit-Reset header correctly', async () => {
    const { RateLimitTracker } = await import('../src/evaluator.js');
    const tracker = new RateLimitTracker(10_000, 300_000);
    const headers = new Headers({
      'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 60),
    });
    tracker.parseRateLimitHeaders('openai', 'gpt-4o-mini', headers);
    const { wait, waitMs } = tracker.shouldWait('openai', 'gpt-4o-mini');
    expect(wait).toBe(true);
    expect(waitMs).toBeGreaterThan(50_000);
  });

  it('handles X-RateLimit-Remaining: 0 as a back-off signal', async () => {
    const { RateLimitTracker } = await import('../src/evaluator.js');
    const tracker = new RateLimitTracker(10_000, 300_000);
    const headers = new Headers({ 'X-RateLimit-Remaining': '0' });
    tracker.parseRateLimitHeaders('anthropic', 'claude-sonnet-4-6', headers);
    expect(tracker.shouldWait('anthropic', 'claude-sonnet-4-6').wait).toBe(true);
  });

  it('reset() clears all tracking state', async () => {
    const { RateLimitTracker } = await import('../src/evaluator.js');
    const tracker = new RateLimitTracker(10_000, 300_000);
    tracker.record429('openai', 'gpt-4o-mini', 5_000);
    tracker.reset();
    expect(tracker.shouldWait('openai', 'gpt-4o-mini').wait).toBe(false);
  });
});

// ── fetchWithRetry ────────────────────────────────────────────────────────────

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    process.env.OPENAI_API_KEY = 'test-key-openai';
    process.env.ANTHROPIC_API_KEY = 'test-key-anthropic';
    process.env.GLM_API_KEY = 'test-key-glm';
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GLM_API_KEY;
    const { resetRateLimitTracker } = await import('../src/evaluator.js');
    resetRateLimitTracker();
  });

  it('returns successful response on 200', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers(),
      body: makeBodyStream(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })),
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as unknown as Response);

    const { fetchWithRetry } = await import('../src/evaluator.js');
    const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', { method: 'POST' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
  });

  it('retries 429 with exponential backoff and records 429', async () => {
    const responses = [
      { ok: false, status: 429, headers: new Headers({ 'Retry-After': '1' }), text: async () => '{"error":"rate limited"}' },
      { ok: true, status: 200, headers: new Headers(), body: makeBodyStream('{}'), text: async () => '{}' },
    ];
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses[callCount++] as unknown as Response);

    const { fetchWithRetry } = await import('../src/evaluator.js');
    const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
    }, { maxRetries: 3, initialDelayMs: 500, provider: 'openai', model: 'gpt-4o-mini' });

    expect(res.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  it('retries 500-series errors with backoff', async () => {
    const responses = [
      { ok: false, status: 503, headers: new Headers(), text: async () => 'Service Unavailable' },
      { ok: true, status: 200, headers: new Headers(), body: makeBodyStream('{}'), text: async () => '{}' },
    ];
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses[callCount++] as unknown as Response);

    const { fetchWithRetry } = await import('../src/evaluator.js');
    const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
    }, { maxRetries: 3, initialDelayMs: 500, provider: 'openai', model: 'gpt-4o-mini' });

    expect(res.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  it('does not retry 400 errors', async () => {
    const fakeResponse = {
      ok: false, status: 400,
      headers: new Headers(),
      text: async () => 'Bad Request',
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as unknown as Response);

    const { fetchWithRetry } = await import('../src/evaluator.js');
    const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
    }, { maxRetries: 3, initialDelayMs: 500, provider: 'openai', model: 'gpt-4o-mini' });

    expect(res.status).toBe(400);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('respects explicit Retry-After header on 429', async () => {
    const responses = [
      { ok: false, status: 429, headers: new Headers({ 'Retry-After': '2' }), text: async () => 'rate limited' },
      { ok: true, status: 200, headers: new Headers(), body: makeBodyStream('{}'), text: async () => '{}' },
    ];
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses[callCount++] as unknown as Response);

    const { fetchWithRetry } = await import('../src/evaluator.js');

    const start = Date.now();
    const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
    }, { maxRetries: 3, initialDelayMs: 500, provider: 'openai', model: 'gpt-4o-mini' });

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(res.ok).toBe(true);
  });

  it('aborts on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const signal: AbortSignal | undefined = init?.signal as AbortSignal | undefined;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // Simulate a long-running fetch that respects abort
      const delay = new Promise<void>((_, reject) => {
        const abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', abortHandler, { once: true });
        // Also timeout after 10s to avoid hanging in real time
        const fallback = setTimeout(() => {
          signal?.removeEventListener('abort', abortHandler);
          reject(new Error('Fetch took too long'));
        }, 10_000);
        // Clean up fallback if abort fires first
        signal?.addEventListener('abort', () => clearTimeout(fallback), { once: true });
      });
      await delay;
      return { ok: true, status: 200, headers: new Headers(), text: async () => '{}' } as unknown as Response;
    });

    const { fetchWithRetry } = await import('../src/evaluator.js');
    const promise = fetchWithRetry('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
    }, { timeoutMs: 100, maxRetries: 0 });

    await expect(promise).rejects.toThrow();
  });
});

// ── Provider call routing ────────────────────────────────────────────────────

describe('callModelFull', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    process.env.OPENAI_API_KEY = 'test-key-openai';
    process.env.ANTHROPIC_API_KEY = 'test-key-anthropic';
    process.env.GLM_API_KEY = 'test-key-glm';
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GLM_API_KEY;
    const { resetRateLimitTracker } = await import('../src/evaluator.js');
    resetRateLimitTracker();
  });

  it('calls OpenAI endpoint for openai provider', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers(),
      body: makeBodyStream(JSON.stringify({
        choices: [{ message: { content: 'OpenAI response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })),
      text: async () => JSON.stringify({ choices: [{ message: { content: 'OpenAI response' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      json: async () => ({ choices: [{ message: { content: 'OpenAI response' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as unknown as Response);

    const { callModelFull } = await import('../src/evaluator.js');
    const result = await callModelFull(OPENAI_MODEL, 'Hello');
    expect(result.output).toBe('OpenAI response');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it('calls Anthropic messages endpoint for anthropic provider', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers(),
      body: makeBodyStream(JSON.stringify({ content: [{ text: 'Claude response' }], usage: { input_tokens: 10, output_tokens: 8 } })),
      text: async () => JSON.stringify({ content: [{ text: 'Claude response' }], usage: { input_tokens: 10, output_tokens: 8 } }),
      json: async () => ({ content: [{ text: 'Claude response' }], usage: { input_tokens: 10, output_tokens: 8 } }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as unknown as Response);

    const { callModelFull } = await import('../src/evaluator.js');
    const result = await callModelFull(ANTHROPIC_MODEL, 'Hello');
    expect(result.output).toBe('Claude response');
  });

  it('calls Ollama /api/generate endpoint', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers(),
      body: makeBodyStream(JSON.stringify({ response: 'Ollama response', prompt_eval_count: 5, eval_count: 10 })),
      text: async () => JSON.stringify({ response: 'Ollama response', prompt_eval_count: 5, eval_count: 10 }),
      json: async () => ({ response: 'Ollama response', prompt_eval_count: 5, eval_count: 10 }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as unknown as Response);

    const { callModelFull } = await import('../src/evaluator.js');
    const result = await callModelFull(OLLAMA_MODEL, 'Hello');
    expect(result.output).toBe('Ollama response');
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(10);
  });

  it('calls GLM OpenAI-compatible endpoint for glm provider', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers(),
      body: makeBodyStream(JSON.stringify({
        choices: [{ message: { content: 'GLM response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      })),
      text: async () => JSON.stringify({ choices: [{ message: { content: 'GLM response' } }], usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } }),
      json: async () => ({ choices: [{ message: { content: 'GLM response' } }], usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as unknown as Response);

    const { callModelFull } = await import('../src/evaluator.js');
    const result = await callModelFull(GLM_MODEL, 'Hello');
    expect(result.output).toBe('GLM response');
    expect(result.inputTokens).toBe(10);
  });

  it('throws when API key is missing for a provider that requires one', async () => {
    delete process.env.OPENAI_API_KEY;
    const { callModelFull } = await import('../src/evaluator.js');
    await expect(callModelFull(OPENAI_MODEL, 'Hello')).rejects.toThrow();
  });

  it('estimates tokens when usage is absent in response', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers(),
      body: makeBodyStream(JSON.stringify({ choices: [{ message: { content: 'Short response' } }] })),
      text: async () => JSON.stringify({ choices: [{ message: { content: 'Short response' } }] }),
      json: async () => ({ choices: [{ message: { content: 'Short response' } }] }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as unknown as Response);

    const { callModelFull } = await import('../src/evaluator.js');
    const result = await callModelFull(OPENAI_MODEL, 'Hello');
    expect(result.output).toBe('Short response');
    expect(result.inputTokens).toBeGreaterThan(0);
  });
});

// ── calcCost (from router.ts) ───────────────────────────────────────────────

describe('calcCost', () => {
  it('calculates cost correctly for OpenAI model', async () => {
    const { calcCost } = await import('../src/router.js');
    const cost = calcCost(1_000_000, 1_000_000, OPENAI_MODEL);
    expect(cost).toBeCloseTo(0.75, 2);
  });

  it('calculates cost correctly for Anthropic model', async () => {
    const { calcCost } = await import('../src/router.js');
    const cost = calcCost(1_000_000, 1_000_000, ANTHROPIC_MODEL);
    expect(cost).toBeCloseTo(18, 2);
  });

  it('returns 0 for Ollama (free local model)', async () => {
    const { calcCost } = await import('../src/router.js');
    expect(calcCost(1_000_000, 1_000_000, OLLAMA_MODEL)).toBe(0);
  });

  it('handles zero tokens', async () => {
    const { calcCost } = await import('../src/router.js');
    expect(calcCost(0, 0, OPENAI_MODEL)).toBe(0);
  });

  it('handles fractional token counts without floating-point errors', async () => {
    const { calcCost } = await import('../src/router.js');
    const cost = calcCost(1, 1, OPENAI_MODEL);
    expect(cost).toBeGreaterThan(0);
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeLessThan(0.0001);
  });
});
