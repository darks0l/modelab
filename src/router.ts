import type { ModelConfig } from './types.js';

/**
 * Complexity estimation based on keyword heuristics.
 */
export type TaskComplexity = 'quick' | 'balanced' | 'reasoning' | 'coding';

const CODE_KEYWORDS = /\b(code|refactor|bug|fix|test|build|repo|pull.request|pr\b|typescript|javascript|python|rust|compile|lint|eslint|prettier|npm|yarn|cargo)\b/i;
const REASON_KEYWORDS = /\b(reason|proof|logic|analysis|theorem|prove|prove|conjecture|derive|evaluate|compare|contrast|critique|synthesis)\b/i;
const QUICK_KEYWORDS = /\b(quick|small|summary|brief|one.liner|quick.summary|what.is|define|lookup)\b/i;

export function estimateComplexity(task: string): TaskComplexity {
  if (CODE_KEYWORDS.test(task)) return 'coding';
  if (REASON_KEYWORDS.test(task)) return 'reasoning';
  if (QUICK_KEYWORDS.test(task)) return 'quick';
  return 'balanced';
}

/**
 * Route a task to the best-fit model from a configured model pool.
 *
 * Routing logic:
 * - coding task  → look for "coding" key, else "balanced"
 * - reasoning    → "reasoning" > "balanced"
 * - quick task  → "fast" > "balanced"
 * - default     → "balanced"
 *
 * If the preferred key is missing, falls back to "balanced".
 */
export function routeTask(
  task: string,
  modelConfigs: Record<string, ModelConfig>
): ModelConfig {
  const complexity = estimateComplexity(task);
  const keys = Object.keys(modelConfigs);

  // Ordered preference list for each complexity tier
  const preferenceMap: Record<TaskComplexity, string[]> = {
    coding:    ['coding', 'balanced', 'fast', 'reasoning'],
    reasoning: ['reasoning', 'balanced', 'fast'],
    quick:     ['fast', 'balanced'],
    balanced:  ['balanced', 'fast', 'reasoning', 'coding'],
  };

  const preferred = preferenceMap[complexity];

  for (const key of preferred) {
    if (keys.includes(key)) {
      return modelConfigs[key];
    }
  }

  // Ultimate fallback: first configured model
  return modelConfigs[keys[0]];
}

/**
 * Calculate USD cost for a token usage report.
 */
export function calcCost(
  inputTokens: number,
  outputTokens: number,
  config: ModelConfig
): number {
  const inputRate = config.costPerMillionInput ?? 0;
  const outputRate = config.costPerMillionOutput ?? 0;
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}
