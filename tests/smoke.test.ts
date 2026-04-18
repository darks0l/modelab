import { describe, it, expect } from 'vitest';
import { routeTask, estimateComplexity } from '../src/router.js';
import type { ModelConfig } from '../src/types.js';

const MODELS: Record<string, ModelConfig> = {
  fast:     { provider: 'openai',   model: 'gpt-4o-mini',    costPerMillionInput: 0.15, costPerMillionOutput: 0.60 },
  balanced: { provider: 'anthropic', model: 'claude-sonnet-4-6', costPerMillionInput: 3,   costPerMillionOutput: 15 },
  reasoning: { provider: 'openai',   model: 'o1',              costPerMillionInput: 15,  costPerMillionOutput: 60 },
  coding:   { provider: 'ollama',   model: 'qwen3-coder',     costPerMillionInput: 0,    costPerMillionOutput: 0 },
};

describe('router', () => {
  it('routes coding tasks to coding model', () => {
    const result = routeTask('refactor this typescript function', MODELS);
    expect(result.model).toBe('qwen3-coder');
  });

  it('routes reasoning tasks to reasoning model', () => {
    const result = routeTask('prove that P != NP', MODELS);
    expect(result.model).toBe('o1');
  });

  it('routes quick tasks to fast model', () => {
    const result = routeTask('what is a merkle tree', MODELS);
    expect(result.model).toBe('gpt-4o-mini');
  });

  it('routes default tasks to balanced', () => {
    const result = routeTask('explain how consensus works', MODELS);
    expect(result.model).toBe('claude-sonnet-4-6');
  });
});

describe('estimateComplexity', () => {
  it('classifies coding tasks', () => {
    expect(estimateComplexity('write a test for this bug')).toBe('coding');
  });
  it('classifies reasoning tasks', () => {
    expect(estimateComplexity('prove this theorem')).toBe('reasoning');
  });
  it('classifies quick tasks', () => {
    expect(estimateComplexity('quick summary')).toBe('quick');
  });
  it('falls back to balanced', () => {
    expect(estimateComplexity('tell me about ethereum')).toBe('balanced');
  });
});
