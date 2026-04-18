import type { ExperimentResult } from './types.js';
export interface IterationSummary {
    id: string;
    runId: string;
    goalId: string;
    iteration: number;
    /** Best score achieved this iteration */
    bestScore: number | null;
    /** Which arm achieved the best score */
    bestArmId: string | null;
    /** What worked — concatenated snippets from winning outputs */
    whatWorked: string;
    /** What didn't work */
    whatDidntWork: string;
    /** Key takeaway one-liner */
    lesson: string;
    /** Full raw summary text */
    summaryText: string;
    createdAt: string;
}
export interface RunLatencyStats {
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
    sampleCount: number;
}
export interface RunSummary {
    runId: string;
    goalId: string;
    status: string;
    totalCostUsd: number;
    totalArms: number;
    totalIterations: number;
    bestScore: number | null;
    bestArmId: string | null;
    bestIteration: number | null;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    /** Per-iteration summaries for this run */
    iterationSummaries: IterationSummary[];
    /** Key experiment-level lesson */
    lesson: string;
    /** Full run report text */
    report: string;
    /** TTFT latency statistics across all arms */
    latencyStats: RunLatencyStats;
}
export interface IterationContext {
    iteration: number;
    priorIterations: IterationSummary[];
    bestScoreSoFar: number | null;
    bestArmSoFar: string | null;
    /** Markdown-formatted context string for injection into prompts */
    contextString: string;
}
export declare class ExperimentMemory {
    private db;
    constructor();
    log(result: ExperimentResult, runId: string, goalId: string): void;
    getHistory(goalId?: string): ExperimentResult[];
    getBest(goalId: string): ExperimentResult | null;
    getAverageScore(goalId: string): number | null;
    getTotalSpend(goalId?: string): number;
    /**
     * Summarize what happened in a completed iteration and store it.
     * Call this after each iteration completes (after all arms have run).
     */
    summarize(runId: string, goalId: string, iteration: number, results: ExperimentResult[]): IterationSummary;
    /**
     * Get all iteration summaries for a goal (across all runs).
     */
    getSummaries(goalId: string): IterationSummary[];
    /**
     * Get the iteration context needed before starting iteration `iter`.
     * This aggregates all prior iterations and formats them as a prompt string
     * that can be injected as {{iteration_context}} into arm prompts.
     */
    getContextForIteration(goalId: string, runId: string, iter: number): IterationContext;
    /**
     * Get all "lessons" — the distilled takeaways across all goals/runs.
     * Useful for the `modelab lessons` CLI command.
     */
    getLessons(goalId?: string): {
        goalId: string;
        runId: string;
        iteration: number;
        lesson: string;
        bestScore: number | null;
    }[];
    /**
     * Summarize an entire run after it completes — aggregates all iteration summaries
     * into a single run-level view. Stored in the run_summaries table.
     * Call this once at the end of `orchestrator.run()`.
     */
    summarizeRun(runId: string, goalId: string, status: string, startedAt: string, completedAt: string, allResults: ExperimentResult[]): RunSummary;
    /**
     * Get all run summaries, optionally filtered by goalId.
     */
    getRunSummaries(goalId?: string): RunSummary[];
    /**
     * Get a single run summary by runId.
     */
    getRun(runId: string): RunSummary | null;
    /**
     * Compute TTFT latency statistics for a specific run from the experiments table.
     * Called when reconstructing RunSummary objects from storage.
     */
    private _latencyStatsForRun;
    close(): void;
}
//# sourceMappingURL=memory.d.ts.map