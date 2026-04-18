import { describe, it, expect } from 'vitest';
import { estimateComplexity, routeTask, calcCost } from '../src/router.js';
import type { ModelConfig } from '../src/types.js';

const MODELS: Record<string, ModelConfig> = {
  fast:     { provider: 'openai',     model: 'gpt-4o-mini',     costPerMillionInput: 0.15, costPerMillionOutput: 0.60 },
  balanced: { provider: 'anthropic', model: 'claude-sonnet-4-6', costPerMillionInput: 3,   costPerMillionOutput: 15 },
  reasoning: { provider: 'openai',  model: 'o1',                costPerMillionInput: 15,  costPerMillionOutput: 60 },
  coding:   { provider: 'ollama',    model: 'qwen3-coder',       costPerMillionInput: 0,   costPerMillionOutput: 0 },
};

// ── estimateComplexity ──────────────────────────────────────────────────────

describe('estimateComplexity', () => {
  const tests: Array<{ task: string; expected: ReturnType<typeof estimateComplexity> }> = [
    // coding
    { task: 'write a typescript function to parse dates', expected: 'coding' },
    { task: 'review this pull request for bugs', expected: 'coding' },
    { task: 'fix the null pointer exception in auth.ts', expected: 'coding' },
    { task: 'run npm build and check for lint errors', expected: 'coding' },
    { task: 'explain how rust lifetimes work', expected: 'coding' },
    // reasoning
    { task: 'prove that there are infinitely many primes', expected: 'reasoning' },
    { task: 'analyze the tradeoffs between A* and Dijkstra', expected: 'reasoning' },
    { task: 'evaluate the strengths and weaknesses of this argument', expected: 'reasoning' },
    { task: 'compare and contrast functional vs object-oriented programming', expected: 'reasoning' },
    { task: 'critique this research methodology', expected: 'reasoning' },
    { task: 'derive the formula for compound interest', expected: 'reasoning' },
    // quick
    { task: 'what is the capital of france', expected: 'quick' },
    { task: 'define "ubiquitous"', expected: 'quick' },
    { task: 'give me a one-sentence summary of this article', expected: 'quick' },
    // balanced (default)
    { task: 'explain how photosynthesis works', expected: 'balanced' },
    { task: 'what are the main causes of climate change', expected: 'balanced' },
    { task: 'help me think through moving to a new city', expected: 'balanced' },
  ];

  it.each(tests)('classifies "$task" as $expected', ({ task, expected }) => {
    expect(estimateComplexity(task)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(estimateComplexity('WRITE CODE')).toBe('coding');
    expect(estimateComplexity('ProVe a theorem')).toBe('reasoning');
    expect(estimateComplexity('What IS the capital')).toBe('quick');
  });

  it('returns balanced when no keywords match', () => {
    expect(estimateComplexity('tell me a story about dragons')).toBe('balanced');
    expect(estimateComplexity('i need advice on learning to paint')).toBe('balanced');
  });
});

// ── routeTask ────────────────────────────────────────────────────────────────

describe('routeTask', () => {
  it('routes coding tasks to the coding model', () => {
    const result = routeTask('write a function to reverse a string', MODELS);
    expect(result.model).toBe('qwen3-coder');
    expect(result.provider).toBe('ollama');
    expect(result.reasoning).toContain('coding');
  });

  it('routes reasoning tasks to the reasoning model', () => {
    const result = routeTask('prove that the square root of 2 is irrational', MODELS);
    expect(result.model).toBe('o1');
    expect(result.provider).toBe('openai');
    expect(result.reasoning).toContain('reasoning');
  });

  it('routes quick tasks to the fast model', () => {
    const result = routeTask('what is the meaning of life in one sentence', MODELS);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.provider).toBe('openai');
    expect(result.reasoning).toContain('quick');
  });

  it('routes balanced tasks to the balanced model', () => {
    const result = routeTask('explain how the immune system works', MODELS);
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.provider).toBe('anthropic');
    expect(result.reasoning).toContain('balanced');
  });

  it('falls back when preferred key is missing', () => {
    // Only 'fast' and 'balanced' available — no 'coding'
    const limited = { fast: MODELS.fast, balanced: MODELS.balanced };
    const result = routeTask('write a python script to sort a list', limited);
    // coding prefers: coding > balanced > fast > reasoning → balanced is the fallback
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.reasoning).toContain('balanced');
  });

  it('falls back to first key when no preference-key exists', () => {
    // 'custom' is not in ANY preference chain, so the function returns the first
    // available key ('custom') with 'fallback' reasoning
    const customOnly = { custom: { provider: 'openai', model: 'gpt-4o', costPerMillionInput: 0.15, costPerMillionOutput: 0.60 } };
    const result = routeTask('what is 2+2', customOnly);
    expect(result.model).toBe('gpt-4o');
    expect(result.reasoning).toContain('fallback');
  });

  it('returns correct model and provider in result', () => {
    const result = routeTask('compare postgres and mongodb for a new startup', MODELS);
    expect(result).toHaveProperty('model');
    expect(result).toHaveProperty('provider');
    expect(result).toHaveProperty('reasoning');
    expect(typeof result.model).toBe('string');
    expect(typeof result.provider).toBe('string');
    expect(typeof result.reasoning).toBe('string');
  });

  it('handles empty task string (returns balanced)', () => {
    const result = routeTask('', MODELS);
    expect(result.reasoning).toContain('balanced');
  });

  it('prefers reasoning over balanced for reasoning tasks', () => {
    const result = routeTask('analyze the implications of this theorem', MODELS);
    expect(result.model).toBe('o1');
  });
});

// ── calcCost ────────────────────────────────────────────────────────────────

describe('calcCost', () => {
  it('returns 0 for zero tokens', () => {
    expect(calcCost(0, 0, MODELS.balanced)).toBe(0);
  });

  it('calculates input token cost correctly', () => {
    // 1M tokens at $3/M → $3
    expect(calcCost(1_000_000, 0, MODELS.balanced)).toBeCloseTo(3, 4);
    // 500K tokens at $3/M → $1.50
    expect(calcCost(500_000, 0, MODELS.balanced)).toBeCloseTo(1.5, 4);
  });

  it('calculates output token cost correctly', () => {
    // 1M output tokens at $15/M → $15
    expect(calcCost(0, 1_000_000, MODELS.balanced)).toBeCloseTo(15, 4);
  });

  it('sums input and output costs', () => {
    // 1M in at $3 + 1M out at $15 → $18
    expect(calcCost(1_000_000, 1_000_000, MODELS.balanced)).toBeCloseTo(18, 4);
  });

  it('handles fractional token counts', () => {
    // 1000 tokens at $0.15/1M → $0.00015
    expect(calcCost(1000, 0, MODELS.fast)).toBeCloseTo(0.00015, 6);
  });

  it('handles zero-cost models (ollama)', () => {
    expect(calcCost(1_000_000, 1_000_000, MODELS.coding)).toBe(0);
  });

  it('handles models with only input cost', () => {
    const inOnly = { ...MODELS.fast, costPerMillionOutput: 0 };
    expect(calcCost(1_000_000, 500_000, inOnly)).toBeCloseTo(0.15, 4);
  });

  it('handles undefined costPerMillion* (treats as 0)', () => {
    // @ts-expect-error testing runtime behavior with missing fields
    const noCost: ModelConfig = { provider: 'openai', model: 'test' };
    expect(calcCost(1_000_000, 1_000_000, noCost)).toBe(0);
  });

  it('handles small token counts without floating-point errors', () => {
    // 1 token in + 1 token out should not be Infinity or NaN
    const cost = calcCost(1, 1, MODELS.balanced);
    expect(cost).toBeGreaterThan(0);
    expect(Number.isFinite(cost)).toBe(true);
  });
});
