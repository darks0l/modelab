/**
 * Complexity estimation based on keyword heuristics.
 * Extracted from router.ts to avoid circular imports with routing_v2.ts.
 */
export type TaskComplexity = 'quick' | 'balanced' | 'reasoning' | 'coding';
export declare function estimateComplexity(task: string): TaskComplexity;
//# sourceMappingURL=complexity.d.ts.map