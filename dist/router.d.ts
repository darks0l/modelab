import type { ModelConfig } from './types.js';
/**
 * Complexity estimation based on keyword heuristics.
 */
export type TaskComplexity = 'quick' | 'balanced' | 'reasoning' | 'coding';
export declare function estimateComplexity(task: string): TaskComplexity;
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
export declare function routeTask(task: string, modelConfigs: Record<string, ModelConfig>): {
    model: string;
    provider: string;
    reasoning: string;
};
/**
 * Calculate USD cost for a token usage report.
 */
export declare function calcCost(inputTokens: number, outputTokens: number, config: ModelConfig): number;
//# sourceMappingURL=router.d.ts.map