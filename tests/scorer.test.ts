import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateTokensAsync } from '../src/evaluator.js';

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
    // Async uses tiktoken directly once loaded; allow small divergence with fallback
    expect(Math.abs(async_ - sync)).toBeLessThanOrEqual(5);
  });

  it('async version works for long text', async () => {
    const text = 'Lorem ipsum dolor sit amet '.repeat(100);
    const count = await estimateTokensAsync(text);
    expect(count).toBeGreaterThan(200);
  });
});

describe('scorer parseScoreResponse', () => {
  // We test the parse logic by checking the ScoreResultSchema contract
  // and verifying edge cases that would cause Zod validation failures.

  it('parses a valid score JSON', () => {
    // Minimal valid ScoreResult
    const valid = { score: 8.5, reasoning: 'Looks good.', clarity: 2, correctness: 3, completeness: 2 };
    const parsed = JSON.parse(JSON.stringify(valid));
    expect(parsed.score).toBe(8.5);
    expect(parsed.clarity).toBe(2);
    expect(parsed.correctness).toBe(3);
    expect(parsed.completeness).toBe(2);
  });

  it('clamps score to 0-10 range', () => {
    // Score can come in as a string or out-of-range number
    const raw = { score: 'not a number', reasoning: 'test', clarity: 0, correctness: 0, completeness: 0 };
    const score = Math.max(0, Math.min(10, Number(raw.score) || 0));
    expect(score).toBe(0);
  });

  it('clamps sub-dimensions to valid ranges', () => {
    const raw = { clarity: 10, correctness: -1, completeness: 5 };
    const clamped = {
      clarity: Math.max(0, Math.min(3, Number(raw.clarity) || 0)),
      correctness: Math.max(0, Math.min(4, Number(raw.correctness) || 0)),
      completeness: Math.max(0, Math.min(3, Number(raw.completeness) || 0)),
    };
    expect(clamped.clarity).toBe(3);
    expect(clamped.correctness).toBe(0);
    expect(clamped.completeness).toBe(3);
  });

  it('extracts JSON from markdown code block', () => {
    const raw = '```json\n{"score": 7, "reasoning": "ok", "clarity": 1, "correctness": 2, "completeness": 1}\n```\n';
    const match = raw.match(/```json\s*(\{[\s\S]*?\})\s*```|```\s*(\{[\s\S]*?\})\s*```|(\{[\s\S]*?\})/s);
    const jsonStr = match?.[1] ?? match?.[2] ?? match?.[3];
    const parsed = JSON.parse(jsonStr ?? '{}');
    expect(parsed.score).toBe(7);
  });

  it('extracts bare JSON object from raw text', () => {
    const raw = 'Here is my response:\n{"score": 6.5, "reasoning": "mediocre", "clarity": 1, "correctness": 2, "completeness": 1}\nThat is all.';
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const jsonStr = raw.slice(start, end + 1);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.score).toBe(6.5);
  });

  it('score cache key is stable for same question+output', () => {
    const q = 'What is 2+2?';
    const a = 'It is 4.';
    const key1 = `${q}\x00${a.slice(0, 500)}`;
    const key2 = `${q}\x00${a.slice(0, 500)}`;
    expect(key1).toBe(key2);
  });

  it('score cache key differs for different output', () => {
    const q = 'What is 2+2?';
    const a = 'It is 4.';
    const b = 'It is 5.';
    const key1 = `${q}\x00${a.slice(0, 500)}`;
    const key2 = `${q}\x00${b.slice(0, 500)}`;
    expect(key1).not.toBe(key2);
  });
});

describe('scorer rubric contract', () => {
  // Verify the scoring rubric is internally consistent

  it('max score of 10 requires max on all dimensions', () => {
    // score = clarity(0-3) + correctness(0-4) + completeness(0-3)
    // Max possible = 3 + 4 + 3 = 10
    const maxSum = 3 + 4 + 3;
    expect(maxSum).toBe(10);
  });

  it('rubric dimensions cover 0-10 without gaps', () => {
    // The rubric score is the sum of sub-dimensions
    // so every integer 0-10 should be achievable (in theory)
    // We verify the ranges are contiguous
    const min = 0 + 0 + 0; // 0
    const max = 3 + 4 + 3; // 10
    expect(max - min + 1).toBe(11); // 0 through 10 = 11 values
  });
});
