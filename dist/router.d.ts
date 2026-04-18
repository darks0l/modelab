import type { ModelConfig } from './types.js';
/**
 * Complexity estimation based on keyword heuristics.
 */
export type TaskComplexity = 'quick' | 'balanced' | 'reasoning' | 'coding';
export declare function estimateComplexity(task: string): TaskComplexity;
export type RoutingMode = 'quality' | 'latency' | 'cost';
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
 *
 * With mode='latency', routes to the model configured as 'fast' if available,
 * regardless of task complexity — useful for interactive/low-latency applications.
 * With mode='cost', prefers models with lower costPerMillionOutput.
 */
export declare function routeTask(task: string, modelConfigs: Record<string, ModelConfig>, mode?: RoutingMode): {
    model: string;
    provider: string;
    reasoning: string;
};
/**
 * Calculate USD cost for a token usage report.
 */
export declare function calcCost(inputTokens: number, outputTokens: number, config: ModelConfig): number;
//# sourceMappingURL=router.d.ts.map