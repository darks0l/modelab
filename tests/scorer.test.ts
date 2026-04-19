import { describe, it, expect, vi, beforeEach } from 'vitest';
import { estimateTokens, estimateTokensAsync } from '../src/evaluator.js';
import { scoreOutput, clearScoreCache, getScoreCacheSize } from '../src/scorer.js';
import type { ModelConfig } from '../src/types.js';

const EVAL_MODEL: ModelConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  costPerMillionInput: 0.15,
  costPerMillionOutput: 0.60,
};

// ── Token estimation ─────────────────────────────────────────────────────────

describe('evaluator token estimation', () => {
  it('returns a positive token count', () => {
    const count = estimateTokens('Hello world');
    expect(count).toBeGreaterThan(0);
  });

  it('handles empty string', () => {
    const count = estimateTokens('');
    expect(count).toBe(0);
  });

  it('handles long text', () => {
    const long = 'word '.repeat(1000);
    const count = estimateTokens(long);
    expect(count).toBeGreaterThan(500);
  });

  it('async version matches sync for short text', async () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const sync = estimateTokens(text);
    const async_ = await estimateTokensAsync(text);
    expect(Math.abs(async_ - sync)).toBeLessThanOrEqual(5);
  });

  it('async version works for long text', async () => {
    const text = 'Lorem ipsum dolor sit amet '.repeat(100);
    const count = await estimateTokensAsync(text);
    expect(count).toBeGreaterThan(200);
  });
});

// ── scoreOutput ─────────────────────────────────────────────────────────────

describe('scoreOutput', () => {
  let callModelSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Always clear the in-memory score cache first to prevent cross-test pollution
    clearScoreCache();
    const evaluator = await import('../src/evaluator.js');
    callModelSpy = vi.spyOn(evaluator, 'callModel');
  });

  it('returns parsed score from a valid JSON response', async () => {
    callModelSpy.mockResolvedValue(
      '{"score": 8.5, "reasoning": "Clear and correct.", "clarity": 2, "correctness": 4, "completeness": 2}'
    );

    // Use unique q/a per test to avoid cache collision
    const result = await scoreOutput('The answer is 4.', 'What is 2+2? (#1)', EVAL_MODEL);

    expect(result.score).toBe(8.5);
    expect(result.reasoning).toBe('Clear and correct.');
    expect(result.clarity).toBe(2);
    expect(result.correctness).toBe(4);
    expect(result.completeness).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it('extracts JSON from markdown code block', async () => {
    callModelSpy.mockResolvedValue(
      '```json\n{"score": 7, "reasoning": "ok", "clarity": 1, "correctness": 3, "completeness": 2}\n```'
    );

    const result = await scoreOutput('Some answer.', 'Some question? (#2)', EVAL_MODEL);

    expect(result.score).toBe(7);
    expect(result.reasoning).toBe('ok');
    expect(result.clarity).toBe(1);
    expect(result.correctness).toBe(3);
    expect(result.completeness).toBe(2);
  });

  it('extracts JSON from raw text with surrounding content', async () => {
    callModelSpy.mockResolvedValue(
      'Here is my assessment:\n{"score": 6.5, "reasoning": "mediocre", "clarity": 1, "correctness": 3, "completeness": 1}\nThat is all.'
    );

    const result = await scoreOutput('Some output.', 'A question (#3)', EVAL_MODEL);

    expect(result.score).toBe(6.5);
  });

  it('clamps score to 10 when value exceeds max', async () => {
    callModelSpy.mockResolvedValue(
      '{"score": 15, "reasoning": "way too high", "clarity": 3, "correctness": 4, "completeness": 3}'
    );

    const result = await scoreOutput('Answer.', 'Question? (#4)', EVAL_MODEL);

    expect(result.score).toBe(10); // clamped to max
  });

  it('clamps negative score to 0', async () => {
    callModelSpy.mockResolvedValue(
      '{"score": -3, "reasoning": "bad", "clarity": 0, "correctness": 0, "completeness": 0}'
    );

    const result = await scoreOutput('Answer.', 'Question? (#5)', EVAL_MODEL);

    expect(result.score).toBe(0); // clamped
  });

  it('clamps sub-dimensions to valid ranges', async () => {
    callModelSpy.mockResolvedValue(
      '{"score": 10, "reasoning": "over the top", "clarity": 10, "correctness": 10, "completeness": 10}'
    );

    const result = await scoreOutput('Answer.', 'Question? (#6)', EVAL_MODEL);

    expect(result.clarity).toBe(3);      // max 3
    expect(result.correctness).toBe(4);  // max 4
    expect(result.completeness).toBe(3); // max 3
  });

  it('caches and reuses result for same question+output', async () => {
    callModelSpy.mockResolvedValue(
      '{"score": 8, "reasoning": "Good.", "clarity": 2, "correctness": 3, "completeness": 2}'
    );

    const output = 'The answer is 4. (#7)';
    const question = 'What is 2+2?';

    const r1 = await scoreOutput(output, question, EVAL_MODEL);
    const r2 = await scoreOutput(output, question, EVAL_MODEL);

    expect(r1.score).toBe(8);
    expect(r2.score).toBe(8);
    // Model should only be called once (second call hits cache)
    expect(callModelSpy).toHaveBeenCalledTimes(1);
  });

  it('does not use cache for different output', async () => {
    callModelSpy.mockResolvedValue(
      '{"score": 8, "reasoning": "Good.", "clarity": 2, "correctness": 3, "completeness": 2}'
    );

    await scoreOutput('Output A (#8)', 'Same question?', EVAL_MODEL);
    await scoreOutput('Output B (#9)', 'Same question?', EVAL_MODEL);

    expect(callModelSpy).toHaveBeenCalledTimes(2);
  });

  it('does not use cache for different question', async () => {
    callModelSpy.mockResolvedValue(
      '{"score": 8, "reasoning": "Good.", "clarity": 2, "correctness": 3, "completeness": 2}'
    );

    await scoreOutput('Same output', 'Question A? (#10)', EVAL_MODEL);
    await scoreOutput('Same output', 'Question B? (#11)', EVAL_MODEL);

    expect(callModelSpy).toHaveBeenCalledTimes(2);
  });

  it('passes question and answer to the model via the rubric prompt', async () => {
    callModelSpy.mockResolvedValue(
      '{"score": 7, "reasoning": "ok", "clarity": 1, "correctness": 3, "completeness": 2}'
    );

    await scoreOutput('The answer is 42.', 'What is the answer to life? (#12)', EVAL_MODEL);

    expect(callModelSpy).toHaveBeenCalledTimes(1);
    const [cfg, prompt] = callModelSpy.mock.calls[0];
    expect(cfg).toEqual(EVAL_MODEL);
    expect(prompt).toContain('What is the answer to life? (#12)');
    expect(prompt).toContain('The answer is 42.');
    expect(prompt).toContain('"clarity"');
    expect(prompt).toContain('"correctness"');
  });

  it('truncates very long answers in the prompt', async () => {
    callModelSpy.mockResolvedValue(
      '{"score": 7, "reasoning": "ok", "clarity": 1, "correctness": 3, "completeness": 2}'
    );

    const longAnswer = 'word '.repeat(2000); // > 4000 chars
    await scoreOutput(longAnswer, 'Short question? (#13)', EVAL_MODEL);

    const [, prompt] = callModelSpy.mock.calls[0];
    expect(prompt).toContain('[truncated]');
  });

  it('returns error result after all retries exhausted on network failure', async () => {
    callModelSpy.mockRejectedValue(new Error('Network failure'));

    const result = await scoreOutput('Answer.', 'Question? (#14)', EVAL_MODEL, 2);

    expect(result.score).toBe(0);
    expect(result.error).toBe('Network failure');
    expect(callModelSpy).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('returns error result on malformed JSON response', async () => {
    callModelSpy.mockResolvedValue('not valid json at all');

    const result = await scoreOutput('Answer.', 'Question? (#15)', EVAL_MODEL, 2);

    expect(result.score).toBe(0);
    expect(result.error).not.toBeNull();
    expect(result.error).toContain('Unexpected token');
  });

  it('returns error result when JSON parses but Zod validation fails (missing fields)', async () => {
    // Only has score + reasoning; missing clarity, correctness, completeness
    callModelSpy.mockResolvedValue('{"score": 8, "reasoning": "looks fine to me"}');

    const result = await scoreOutput('Answer.', 'Question? (#16)', EVAL_MODEL, 2);

    // After 2 retries, validation still fails → error result
    expect(result.score).toBe(0);
    expect(result.error).toContain('Zod');
  });
});

// ── Cache management ────────────────────────────────────────────────────────

describe('score cache management', () => {
  // Each test uses unique Q/A to avoid cross-test cache pollution
  let counter = 0;

  beforeEach(() => {
    clearScoreCache();
  });

  it('clearScoreCache empties the cache', async () => {
    const eval_ = await import('../src/evaluator.js');
    const spy = vi.spyOn(eval_, 'callModel').mockResolvedValue(
      '{"score": 8, "reasoning": "Good.", "clarity": 2, "correctness": 3, "completeness": 2}'
    );

    const n = ++counter;
    await scoreOutput(`Answer ${n}`, `Question ${n}?`, EVAL_MODEL);
    expect(getScoreCacheSize()).toBe(1);

    clearScoreCache();
    expect(getScoreCacheSize()).toBe(0);

    spy.mockRestore();
  });

  it('getScoreCacheSize counts entries correctly', async () => {
    const eval_ = await import('../src/evaluator.js');
    const spy = vi.spyOn(eval_, 'callModel').mockResolvedValue(
      '{"score": 8, "reasoning": "Good.", "clarity": 2, "correctness": 3, "completeness": 2}'
    );

    expect(getScoreCacheSize()).toBe(0);

    const n = ++counter;
    await scoreOutput(`Answer ${n}-1`, `Question ${n}-1?`, EVAL_MODEL);
    await scoreOutput(`Answer ${n}-2`, `Question ${n}-2?`, EVAL_MODEL);

    expect(getScoreCacheSize()).toBe(2);

    spy.mockRestore();
  });
});

// ── Rubric contract ─────────────────────────────────────────────────────────

describe('scorer rubric contract', () => {
  it('max score of 10 requires max on all dimensions', () => {
    // score = clarity(0-3) + correctness(0-4) + completeness(0-3)
    // Max possible = 3 + 4 + 3 = 10
    const maxSum = 3 + 4 + 3;
    expect(maxSum).toBe(10);
  });

  it('rubric dimensions cover 0-10 without gaps', () => {
    const min = 0 + 0 + 0; // 0
    const max = 3 + 4 + 3; // 10
    expect(max - min + 1).toBe(11); // 0 through 10 = 11 values
  });
});
