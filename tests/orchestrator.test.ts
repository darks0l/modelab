/**
 * Orchestrator unit tests.
 *
 * Uses vi.spyOn + dependency injection (FakeCache / FakeMemory) to test
 * the orchestrator without hitting the network or filesystem.
 */

import { describe, it, expect, beforeEach, vi, type Spy } from 'vitest';
import type { ResearchGoal, ExperimentResult, ModelConfig } from '../src/types.js';
import type { CallResult } from '../src/evaluator.js';
import type { ScoreResult } from '../src/scorer.js';

// ── Fake implementations ────────────────────────────────────────────────────────

/** In-memory cache replacement backed by a Map. */
class FakeCache {
  readonly store = new Map<string, import('../src/cache.js').CacheEntry>();

  lookup(question: string, modelKey: string, armId: string) {
    const key = FakeCache.hash(question, modelKey, armId);
    return this.store.get(key) ?? null;
  }

  set(key: string, result: ExperimentResult, question: string, modelKey: string) {
    this.store.set(key, {
      hash: key,
      output: result.output,
      score: result.score,
      costUsd: result.costUsd,
      tokensUsed: result.tokensUsed,
      timestamp: result.timestamp,
      question,
      modelKey,
      armId: result.armId,
      durationMs: result.durationMs,
      latencyMs: result.latencyMs ?? 0,
    });
  }

  static hash(question: string, modelKey: string, armId: string): string {
    // Must match the real Cache.hash implementation
    const { createHash } = require('crypto') as { createHash: (alg: string) => { update: (s: string) => { digest: (f: string) => string } } };
    return createHash('sha256').update(`${question}:${modelKey}:${armId}`).digest('hex');
  }
}

/** In-memory memory replacement backed by in-memory arrays. */
class FakeMemory {
  readonly log = vi.fn<(result: ExperimentResult, runId: string, goalId: string) => void>();
  readonly getContextForIteration = vi.fn().mockReturnValue({
    iteration: 1,
    priorIterations: [],
    bestScoreSoFar: null,
    bestArmSoFar: null,
    contextString: '',
  });
  readonly summarize = vi.fn().mockReturnValue({
    id: 'sum-test',
    runId: 'run-test',
    goalId: 'goal-test',
    iteration: 1,
    bestScore: 8,
    bestArmId: 'arm-balanced',
    whatWorked: 'Clear explanation.',
    whatDidntWork: '',
    lesson: 'arm-balanced scored 8/10.',
    summaryText: 'Iteration 1 summary.',
    createdAt: new Date().toISOString(),
  });
}

// ── Helper constants ────────────────────────────────────────────────────────────

const MODELS: Record<string, ModelConfig> = {
  fast:     { provider: 'openai',     model: 'gpt-4o-mini',     costPerMillionInput: 0.15, costPerMillionOutput: 0.60 },
  balanced: { provider: 'anthropic', model: 'claude-sonnet-4-6', costPerMillionInput: 3,   costPerMillionOutput: 15 },
};

function makeGoal(overrides: Partial<ResearchGoal> = {}): ResearchGoal {
  return {
    id: 'goal-test-001',
    question: 'What is 2+2?',
    goal: 'Explain addition',
    qualityThreshold: 7,
    maxIterations: 3,
    arms: [
      {
        id: 'arm-balanced',
        name: 'Balanced Arm',
        promptTemplate: 'Answer: {{question}}',
        model: 'balanced',
      },
    ],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Orchestrator', () => {
  let callModelFullSpy: Spy<typeof import('../src/evaluator.js').callModelFull>;
  let scoreOutputSpy: Spy<typeof import('../src/scorer.js').scoreOutput>;
  let fakeCache: FakeCache;
  let fakeMemory: FakeMemory;

  beforeEach(async () => {
    vi.clearAllMocks();

    fakeCache  = new FakeCache();
    fakeMemory = new FakeMemory();

    const evaluatorMod = await import('../src/evaluator.js');
    const scorerMod    = await import('../src/scorer.js');

    callModelFullSpy = vi.spyOn(evaluatorMod, 'callModelFull');
    scoreOutputSpy   = vi.spyOn(scorerMod,    'scoreOutput');

    callModelFullSpy.mockResolvedValue({
      output: 'The answer is 4.',
      inputTokens: 50,
      outputTokens: 20,
    } satisfies CallResult);

    scoreOutputSpy.mockResolvedValue({
      score: 8,
      reasoning: 'Clear and correct.',
      clarity: 2,
      correctness: 3,
      completeness: 2,
    } satisfies ScoreResult);
  });

  const buildOrch = async () => {
    const { ResearchOrchestrator } = await import('../src/orchestrator.js');
    return new ResearchOrchestrator({
      models: MODELS,
      budget: { maxPerRun: 10, maxPerExperiment: 10, trackCosts: true },
      evalModel: 'balanced',
      parallelism: 1,
      memory: fakeMemory,
      cache: fakeCache,
    });
  };

  it('runs a single arm and returns a RunLog', async () => {
    const orch = await buildOrch();
    const goal = makeGoal({ maxIterations: 1 });
    const log = await orch.run(goal);

    expect(log.status).toBe('quality_reached');
    expect(log.allResults).toHaveLength(1);
    expect(log.allResults[0].output).toBe('The answer is 4.');
    expect(log.allResults[0].score).toBe(8);
  });

  it('respects quality threshold and stops early', async () => {
    const orch = await buildOrch();
    const goal = makeGoal({ qualityThreshold: 7, maxIterations: 5 });
    const log = await orch.run(goal);

    // Score 8 >= threshold 7 → stop at iteration 1
    expect(log.status).toBe('quality_reached');
    expect(log.allResults).toHaveLength(1);
  });

  it('continues iterating when quality threshold not met', async () => {
    scoreOutputSpy.mockResolvedValue({
      score: 5,
      reasoning: 'Incomplete.',
      clarity: 1,
      correctness: 2,
      completeness: 1,
    } satisfies ScoreResult);

    const orch = await buildOrch();
    const goal = makeGoal({ qualityThreshold: 9, maxIterations: 2 });
    const log = await orch.run(goal);

    // 1 arm × 2 iterations = 2 results
    expect(log.allResults).toHaveLength(2);
    expect(log.status).toBe('completed');
  });

  it('uses cache when a result is found', async () => {
    const cached: import('../src/cache.js').CacheEntry = {
      hash: FakeCache.hash('What is 2+2?', 'balanced', 'arm-balanced'),
      output: 'Cached answer: 4',
      score: 9,
      costUsd: 0,
      tokensUsed: { input: 0, output: 0 },
      timestamp: new Date().toISOString(),
      question: 'What is 2+2?',
      modelKey: 'balanced',
      armId: 'arm-balanced',
      durationMs: 0,
      latencyMs: 0,
    };
    fakeCache.store.set(cached.hash, cached);

    const orch = await buildOrch();
    const goal = makeGoal();
    const log = await orch.run(goal);

    expect(log.allResults).toHaveLength(1);
    expect(log.allResults[0].cached).toBe(true);
    expect(callModelFullSpy).not.toHaveBeenCalled();
  });

  it('injects cross-iteration context into arm prompts', async () => {
    // Iteration 1: empty context, score won't reach threshold so iteration 2 runs
    // Iteration 2: rich context from iteration 1 — captured by mock
    fakeMemory.getContextForIteration
      .mockReturnValueOnce({
        iteration: 1,
        priorIterations: [],
        bestScoreSoFar: null,
        bestArmSoFar: null,
        contextString: '',
      })
      .mockReturnValueOnce({
        iteration: 2,
        priorIterations: [
          {
            id: 'sum-run-1',
            runId: 'run-test-001',
            goalId: 'goal-test-001',
            iteration: 1,
            bestScore: 7.5,
            bestArmId: 'arm-balanced',
            whatWorked: 'Concise explanation.',
            whatDidntWork: 'Lack of examples.',
            lesson: 'Prefer concise answers.',
            summaryText: 'Iteration 1 summary.',
            createdAt: new Date().toISOString(),
          },
        ],
        bestScoreSoFar: 7.5,
        bestArmSoFar: 'arm-balanced',
        contextString:
          '## Prior Iteration Results (1 prior iteration)\n' +
          '### Iteration 1 — arm-balanced scored 7.5/10\n' +
          '**Lesson:** Prefer concise answers.\n\n' +
          '## Guidance for Next Iteration\n' +
          'So far the best approach is: arm-balanced (7.5/10).',
      });

    let capturedPrompt = '';
    callModelFullSpy.mockImplementation(async (_cfg, prompt) => {
      capturedPrompt = prompt;
      return { output: 'Iteration 2 answer.', inputTokens: 60, outputTokens: 30 };
    });

    const orch = await buildOrch();
    const goal = makeGoal({
      maxIterations: 2,
      qualityThreshold: 9, // force iteration 2 to run
      arms: [{
        id: 'arm-balanced',
        name: 'Balanced Arm',
        promptTemplate: 'Context:\n{{iteration_context}}\n\nQuestion: {{question}}',
        model: 'balanced',
      }],
    });
    await orch.run(goal);

    expect(capturedPrompt).toContain('Prior Iteration Results');
    expect(capturedPrompt).toContain('arm-balanced');
  });

  it('logs results to memory after each arm', async () => {
    const orch = await buildOrch();
    const goal = makeGoal();
    await orch.run(goal);

    expect(fakeMemory.log).toHaveBeenCalled();
    const logged = fakeMemory.log.mock.calls[0][0] as ExperimentResult;
    expect(logged.output).toBe('The answer is 4.');
  });

  it('calls memory.summarize after each iteration', async () => {
    const orch = await buildOrch();
    // qualityThreshold: 9 forces iteration 2 to run (score 8 won't reach it)
    const goal = makeGoal({ maxIterations: 2, qualityThreshold: 9 });
    await orch.run(goal);

    // Once per iteration (2 iterations)
    expect(fakeMemory.summarize).toHaveBeenCalledTimes(2);
  });

  it('tracks total cost across arms', async () => {
    callModelFullSpy.mockResolvedValue({
      output: 'Answer.',
      inputTokens: 1000,
      outputTokens: 500,
    } satisfies CallResult);

    const orch = await buildOrch();
    const goal = makeGoal();
    const log = await orch.run(goal);

    // Claude Sonnet 4-6: 3/M input, 15/M output — 1000+500 tokens → cost > 0
    expect(log.totalCostUsd).toBeGreaterThan(0);
    expect(log.allResults[0].costUsd).toBeGreaterThan(0);
  });

  it('selects best result correctly', async () => {
    const orch = await buildOrch();
    const goal = makeGoal({
      arms: [
        { id: 'arm-slow', name: 'Slow Arm', promptTemplate: 'Answer slowly: {{question}}', model: 'balanced' },
        { id: 'arm-fast',  name: 'Fast Arm',  promptTemplate: 'Answer fast: {{question}}',  model: 'balanced' },
      ],
    });

    let scoreCall = 0;
    callModelFullSpy.mockImplementation(async () => {
      return {
        output: scoreCall++ === 0 ? 'Slow detailed answer.' : 'Quick answer.',
        inputTokens: 50,
        outputTokens: 20,
      };
    });

    scoreOutputSpy.mockImplementation(async () => {
      return ++scoreCall === 2
        ? { score: 9, reasoning: 'Great.', clarity: 3, correctness: 3, completeness: 3 } satisfies ScoreResult
        : { score: 5, reasoning: 'Poor.', clarity: 1, correctness: 2, completeness: 1 } satisfies ScoreResult;
    });

    const log = await orch.run(goal);

    expect(log.bestResult).toBeDefined();
    expect(log.bestResult!.score).toBe(9);
  });

  it('handles model call errors gracefully', async () => {
    callModelFullSpy.mockRejectedValue(new Error('API error: 500'));

    const orch = await buildOrch();
    const goal = makeGoal({ qualityThreshold: 9, maxIterations: 1 });
    const log = await orch.run(goal);

    // Promise.allSettled never rejects — arm errors are caught internally.
    // The run completes with 'completed' status and zero results.
    expect(log.status).toBe('completed');
    expect(log.allResults).toHaveLength(0);
  });

  it('stops when budget is exceeded', async () => {
    const { ResearchOrchestrator } = await import('../src/orchestrator.js');
    const tinyBudgetOrch = new ResearchOrchestrator({
      models: MODELS,
      budget: { maxPerRun: 0.0001, maxPerExperiment: 0.0001, trackCosts: true },
      evalModel: 'balanced',
      parallelism: 1,
      memory: fakeMemory,
      cache: fakeCache,
    });

    const goal = makeGoal({ maxIterations: 3 });
    const log = await tinyBudgetOrch.run(goal);

    expect(log.status).toBe('budget_exceeded');
  });

  it('uses onArmComplete callback when provided', async () => {
    const arms: ExperimentResult[] = [];
    const { ResearchOrchestrator } = await import('../src/orchestrator.js');
    const orch = new ResearchOrchestrator({
      models: MODELS,
      budget: { maxPerRun: 10, maxPerExperiment: 10, trackCosts: true },
      evalModel: 'balanced',
      parallelism: 1,
      memory: fakeMemory,
      cache: fakeCache,
      onArmComplete: (r) => arms.push(r),
    });

    const goal = makeGoal();
    await orch.run(goal);

    expect(arms).toHaveLength(1);
    expect(arms[0].score).toBe(8);
  });

  it('runs multiple arms concurrently when parallelism > 1', async () => {
    let activeCalls = 0;
    let maxConcurrent = 0;
    callModelFullSpy.mockImplementation(async () => {
      activeCalls++;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      await new Promise(r => setTimeout(r, 30));
      activeCalls--;
      return { output: 'Done.', inputTokens: 50, outputTokens: 20 } satisfies CallResult;
    });

    const { ResearchOrchestrator } = await import('../src/orchestrator.js');
    const orch = new ResearchOrchestrator({
      models: MODELS,
      budget: { maxPerRun: 10, maxPerExperiment: 10, trackCosts: true },
      evalModel: 'balanced',
      parallelism: 3,
      memory: fakeMemory,
      cache: fakeCache,
    });

    const goal = makeGoal({
      arms: [
        { id: 'arm-a', name: 'Arm A', promptTemplate: 'A: {{question}}', model: 'balanced' },
        { id: 'arm-b', name: 'Arm B', promptTemplate: 'B: {{question}}', model: 'balanced' },
        { id: 'arm-c', name: 'Arm C', promptTemplate: 'C: {{question}}', model: 'balanced' },
      ],
    });
    await orch.run(goal);

    // With parallelism=3, all 3 arms should overlap concurrently
    expect(maxConcurrent).toBeGreaterThanOrEqual(3);
    expect(callModelFullSpy).toHaveBeenCalledTimes(3);
  });
});
