import type { ResearchGoal, RunLog, ExperimentResult, ModelConfig, ExperimentArm, ModelabConfig } from './types.js';
import { routeTask, calcCost } from './router.js';
import { callModelFull } from './evaluator.js';
import { scoreOutput } from './scorer.js';
import { ExperimentMemory } from './memory.js';
import { Cache } from './cache.js';

export interface OrchestratorConfig extends Omit<ModelabConfig, 'cache' | 'export'> {
  cache?: Cache;
  memory?: ExperimentMemory;
  /** Called when an arm starts streaming a chunk */
  onStream?: (armId: string, chunk: string) => void;
  /** Called when an arm completes */
  onArmComplete?: (result: ExperimentResult) => void;
  /** Called for progress updates */
  onProgress?: (msg: string) => void;
}

const SPINNERS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIdx = 0;

function spin(label: string): string {
  const s = SPINNERS[spinnerIdx++ % SPINNERS.length];
  return `\r${s} ${label}`;
}

function uuid(): string {
  return crypto.randomUUID();
}

export class ResearchOrchestrator {
  private readonly models: Record<string, ModelConfig>;
  private readonly budget: { maxPerRun: number; maxPerExperiment: number; trackCosts: boolean };
  private readonly evalModelKey: string;
  private readonly parallelism: number;
  private readonly memory: ExperimentMemory;
  private readonly cache?: Cache;
  private readonly onStream?: (armId: string, chunk: string) => void;
  private readonly onArmComplete?: (result: ExperimentResult) => void;
  private readonly onProgress?: (msg: string) => void;

  constructor(config: OrchestratorConfig) {
    this.models = config.models;
    this.budget = config.budget;
    this.evalModelKey = config.evalModel;
    this.parallelism = config.parallelism;
    this.memory = config.memory ?? new ExperimentMemory();
    this.cache = config.cache;
    this.onStream = config.onStream;
    this.onArmComplete = config.onArmComplete;
    this.onProgress = config.onProgress;
  }

  async run(goal: ResearchGoal): Promise<RunLog> {
    const runId = uuid();
    const startTime = Date.now();
    let totalCostUsd = 0;
    const allResults: ExperimentResult[] = [];
    let bestResult: ExperimentResult | undefined;
    let status: RunLog['status'] = 'running';

    this.progress(`Starting run ${runId.slice(0, 8)} — "${goal.question.slice(0, 60)}${goal.question.length > 60 ? '...' : ''}"`);
    this.progress(`Threshold: ${goal.qualityThreshold} | Arms: ${goal.arms.length} | Max iterations: ${goal.maxIterations}`);

    try {
      for (let iter = 1; iter <= goal.maxIterations; iter++) {
        this.progress(`\n── Iteration ${iter}/${goal.maxIterations} ──`);

        if (this.budget.maxPerRun > 0 && totalCostUsd >= this.budget.maxPerRun) {
          this.progress('Budget exceeded — stopping');
          status = 'budget_exceeded';
          break;
        }

        // Batch arms by parallelism
        const batches = batchArray(goal.arms, this.parallelism);
        for (const batch of batches) {
          if (this.budget.maxPerRun > 0 && totalCostUsd >= this.budget.maxPerRun) {
            status = 'budget_exceeded';
            break;
          }

          const armResults = await Promise.allSettled(
            batch.map(arm => this.runArm(arm, goal, iter, runId))
          );

          for (const result of armResults) {
            if (result.status === 'rejected') {
              console.error(`  ❌ ${result.reason}`);
              continue;
            }
            const r = result.value;
            allResults.push(r);
            totalCostUsd += r.costUsd;
            this.memory.log(r, runId, goal.id);

            if (r.score !== null && (!bestResult || r.score > (bestResult.score ?? -1))) {
              bestResult = r;
            }

            this.onArmComplete?.(r);
          }
        }

        if (bestResult && bestResult.score !== null && bestResult.score >= goal.qualityThreshold) {
          this.progress(`\n✅ Quality threshold reached: ${bestResult.score} ≥ ${goal.qualityThreshold}`);
          status = 'quality_reached';
          break;
        }
      }

      if (status === 'running') status = 'completed';
    } catch (err) {
      console.error(`\n❌ Run failed:`, err);
      status = 'failed';
    }

    const completedAt = new Date().toISOString();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    this.progress(`\n🏁 Run complete | ${status} | $${totalCostUsd.toFixed(4)} | ${elapsed}s`);

    // Print comparison table
    if (allResults.length > 1) {
      this.printComparisonTable(allResults);
    }

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

  private async runArm(arm: ExperimentArm, goal: ResearchGoal, iteration: number, runId: string): Promise<ExperimentResult> {
    const startMs = Date.now();
    const modelConfig = this.models[arm.model];
    if (!modelConfig) {
      throw new Error(`Unknown model: "${arm.model}". Available: ${Object.keys(this.models).join(', ')}`);
    }

    // Check cache
    if (this.cache) {
      const cached = this.cache.lookup(goal.question, arm.model, arm.id);
      if (cached) {
        this.progress(`  🗃️  ${arm.name}: cache hit — score ${cached.score}`);
        return {
          ...cached,
          iteration,
          cached: true,
          runId,
          goalId: goal.id,
          durationMs: cached.durationMs ?? 0,
        };
      }
    }

    // Fill template
    const variables = { ...arm.variables, question: goal.question, goal: goal.goal };
    const prompt = fillTemplate(arm.promptTemplate, variables);

    // Stream callback
    let streamedOutput = '';
    const streamCb = this.onStream
      ? (chunk: string) => {
          streamedOutput += chunk;
          this.onStream!(arm.name, chunk);
        }
      : undefined;

    let output: string;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const configWithStream = { ...modelConfig, stream: streamCb };
      const result = await callModelFull(configWithStream, prompt);
      output = result.output;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
    } catch (err) {
      throw new Error(`Arm "${arm.name}" failed: ${err}`);
    }

    const costUsd = calcCost(inputTokens, outputTokens, modelConfig);

    if (this.budget.maxPerExperiment > 0 && costUsd > this.budget.maxPerExperiment) {
      throw new Error(`Arm "${arm.name}": cost $${costUsd.toFixed(4)} exceeds per-experiment cap`);
    }

    // Score
    let score: number | null = null;
    const evalConfig = this.models[this.evalModelKey];
    if (evalConfig) {
      const scoreResult = await scoreOutput(output, goal.question, evalConfig);
      score = scoreResult.score;
    }

    const result: ExperimentResult = {
      armId: arm.id,
      output,
      score,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      tokensUsed: { input: inputTokens, output: outputTokens },
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
      iteration,
      cached: false,
      runId,
      goalId: goal.id,
    };

    // Cache the result
    if (this.cache && !result.cached) {
      const key = Cache.hash(goal.question, arm.model, arm.id);
      this.cache.set(key, result, goal.question);
    }

    const scoreStr = score !== null ? `${score}/10` : 'N/A';
    const cachedStr = result.cached ? ' 🗃️' : '';
    this.progress(`  ${result.cached ? '🗃️' : '✅'} ${arm.name}: ${scoreStr}${cachedStr} | $${result.costUsd.toFixed(4)} | ${inputTokens + outputTokens} tokens | ${(result.durationMs / 1000).toFixed(1)}s`);

    return result;
  }

  private printComparisonTable(results: ExperimentResult[]): void {
    const sorted = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const maxOutputLen = 80;

    console.log('\n┌' + '─'.repeat(78) + '┐');
    console.log('│' + ' RESULTS COMPARISON '.padStart(40).padEnd(78) + '│');
    console.log('├' + '─'.repeat(78) + '┤');

    for (const r of sorted) {
      const scoreStr = r.score !== null ? `⭐ ${r.score.toFixed(1)}/10` : '  —  ';
      const cachedStr = r.cached ? ' [cached]' : '';
      const header = ` ${r.armId}${cachedStr} ${scoreStr} $${r.costUsd.toFixed(4)}`;
      const truncated = r.output.length > maxOutputLen ? r.output.slice(0, maxOutputLen) + '...' : r.output;
      console.log('│' + header.padEnd(78) + '│');
      // Word-wrap the output
      const wrapped = wordWrap(truncated, 76);
      for (const line of wrapped.slice(0, 4)) {
        console.log('│  ' + line.padEnd(76) + '│');
      }
      console.log('├' + '─'.repeat(78) + '┤');
    }
    console.log('└' + '─'.repeat(78) + '┘');
  }

  private progress(msg: string): void {
    if (this.onProgress) {
      this.onProgress(msg);
    } else {
      console.log(msg);
    }
  }
}

function batchArray<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) batches.push(arr.slice(i, i + size));
  return batches;
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function wordWrap(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) {
      if (line) lines.push(line.trim());
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line.trim());
  return lines;
}
