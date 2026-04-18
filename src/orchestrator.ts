import type { ResearchGoal, RunLog, ExperimentResult, ModelConfig, ExperimentArm } from './types.js';
import { routeTask, calcCost } from './router.js';
import { evaluate, callModel } from './evaluator.js';
import { ExperimentMemory } from './memory.js';

function uuid(): string {
  return crypto.randomUUID();
}

export interface OrchestratorConfig {
  models: Record<string, ModelConfig>;
  budget: { maxPerRun: number; maxPerExperiment: number; trackCosts: boolean };
  evalModel: string; // key into models
  parallelism: number; // max concurrent arms per iteration
  memory?: ExperimentMemory;
}

export class ResearchOrchestrator {
  private readonly models: Record<string, ModelConfig>;
  private readonly budget: OrchestratorConfig['budget'];
  private readonly evalModelKey: string;
  private readonly parallelism: number;
  private readonly memory: ExperimentMemory;

  constructor(config: OrchestratorConfig) {
    this.models = config.models;
    this.budget = config.budget;
    this.evalModelKey = config.evalModel;
    this.parallelism = config.parallelism;
    this.memory = config.memory ?? new ExperimentMemory();
  }

  async run(goal: ResearchGoal): Promise<RunLog> {
    const runId = uuid();
    const startTime = Date.now();
    let totalCostUsd = 0;
    const allResults: ExperimentResult[] = [];
    let bestResult: ExperimentResult | undefined;
    let status: RunLog['status'] = 'running';

    console.log(`[modelab] Starting run ${runId} for goal: ${goal.question}`);
    console.log(`[modelab] Quality threshold: ${goal.qualityThreshold} | Max iterations: ${goal.maxIterations}`);
    console.log(`[modelab] Arms: ${goal.arms.map(a => a.name).join(', ')}`);

    try {
      for (let iter = 1; iter <= goal.maxIterations; iter++) {
        console.log(`\n[modelab] === Iteration ${iter}/${goal.maxIterations} ===`);

        // Check budget before starting iteration
        if (this.budget.maxPerRun > 0 && totalCostUsd >= this.budget.maxPerRun) {
          console.log('[modelab] Budget exceeded before iteration — stopping');
          status = 'budget_exceeded';
          break;
        }

        // Batch arms in groups of parallelism
        const batches = batchArray(goal.arms, this.parallelism);
        for (const batch of batches) {
          if (this.budget.maxPerRun > 0 && totalCostUsd >= this.budget.maxPerRun) {
            status = 'budget_exceeded';
            break;
          }

          // Run arms in parallel
          const armResults = await Promise.allSettled(
            batch.map(arm => this.runArm(arm, goal, iter))
          );

          for (const result of armResults) {
            if (result.status === 'rejected') {
              console.error('[modelab] Arm failed:', result.reason);
              continue;
            }
            const r = result.value;
            allResults.push(r);
            totalCostUsd += r.costUsd;
            this.memory.log(r, runId, goal.id);

            if (r.score !== null && (!bestResult || r.score > (bestResult.score ?? -1))) {
              bestResult = r;
            }

            console.log(`[modelab] Arm "${r.armId}": score=${r.score ?? 'N/A'} cost=$${r.costUsd.toFixed(4)} tokens=${r.tokensUsed.input + r.tokensUsed.output}`);
          }
        }

        // Check if quality threshold reached
        if (bestResult && bestResult.score !== null && bestResult.score >= goal.qualityThreshold) {
          console.log(`\n[modelab] Quality threshold reached: ${bestResult.score} >= ${goal.qualityThreshold}`);
          status = 'quality_receeded';
          break;
        }
      }

      if (status === 'running') {
        status = 'completed';
      }
    } catch (err) {
      console.error('[modelab] Run failed:', err);
      status = 'failed';
    }

    const completedAt = new Date().toISOString();
    console.log(`\n[modelab] Run ${runId} finished: ${status} | Total cost: $${totalCostUsd.toFixed(4)} | Duration: ${(Date.now() - startTime) / 1000}s`);

    return {
      goalId: goal.id,
      runId,
      status,
      startedAt: new Date(startTime).toISOString(),
      completedAt,
      totalCostUsd: Math.round(totalCostUsd * 1e6) / 1e6,
      bestResult,
      allResults,
    };
  }

  private async runArm(arm: ExperimentArm, goal: ResearchGoal, iteration: number): Promise<ExperimentResult> {
    const startMs = Date.now();
    const modelConfig = this.models[arm.model];
    if (!modelConfig) {
      throw new Error(`Unknown model key: "${arm.model}". Available: ${Object.keys(this.models).join(', ')}`);
    }

    // Fill prompt template
    const variables = { ...arm.variables, question: goal.question, goal: goal.goal };
    const prompt = fillTemplate(arm.promptTemplate, variables);

    let output: string;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const response = await callModel(modelConfig, prompt);
      // Try to extract token usage from the response if available
      // Note: callModel would need to return usage info — simplify for now
      inputTokens = Math.round(prompt.length / 4); // rough estimate
      outputTokens = Math.round(response.length / 4);
      output = response;
    } catch (err) {
      throw new Error(`Model call failed for arm "${arm.id}": ${err}`);
    }

    const costUsd = calcCost(inputTokens, outputTokens, modelConfig);

    // Check per-experiment budget
    if (this.budget.maxPerExperiment > 0 && costUsd > this.budget.maxPerExperiment) {
      console.warn(`[modelab] Arm "${arm.id}" cost $${costUsd.toFixed(4)} exceeds per-experiment cap $${this.budget.maxPerExperiment} — skipping`);
      throw new Error('Per-experiment budget exceeded');
    }

    // Evaluate
    let score: number | null = null;
    const evalConfig = this.models[this.evalModelKey];
    if (evalConfig) {
      score = await evaluate(output, goal.question, evalConfig);
    }

    return {
      armId: arm.id,
      output,
      score,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      tokensUsed: { input: inputTokens, output: outputTokens },
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
      iteration,
    };
  }
}

// ── Utilities ────────────────────────────────────────────────────

function batchArray<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

/** Minimal mustache-style template fill: {{key}} → value */
function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}
