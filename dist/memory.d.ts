import Database from 'better-sqlite3';
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
    /** Best TTFT latency (ms) this iteration */
    bestLatencyMs: number | null;
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
    /** Best (lowest) TTFT latency across all arms */
    bestMs: number | null;
    /** Which arm had the best latency */
    bestArmId: string | null;
}
export interface ModelInsight {
    armFamily: string;
    provider: string;
    model: string;
    taskType: string;
    temperature: number | null;
    sampleSize: number;
    avgScore: number | null;
    avgLatencyMs: number | null;
    avgCostUsd: number | null;
    bestScore: number | null;
    winRate: number;
    lastUsed: string | null;
    verdict: string;
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
    /** Average TTFT latency (ms) across all arms */
    avgLatencyMs: number;
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
    /** @internal */
    db: Database.Database;
    constructor();
    /** @internal - test-only constructor that opens a custom DB path */
    constructor(dbPath: string);
    /**
     * Test-only constructor — opens a database at the given path instead of ~/.modelab/memory.db.
     * Used exclusively by the test suite to test against isolated temp databases.
     * @internal
     */
    log(result: ExperimentResult, runId: string, goalId: string): void;
    getHistory(goalId?: string): ExperimentResult[];
    getBest(goalId: string): ExperimentResult | null;
    getAverageScore(goalId: string): number | null;
    getTotalSpend(goalId?: string): number;
    summarize(runId: string, goalId: string, iteration: number, results: ExperimentResult[]): IterationSummary;
    getSummaries(goalId: string, runId?: string): IterationSummary[];
    getContextForIteration(goalId: string, runId: string, iter: number): IterationContext;
    getLessons(goalId?: string): {
        goalId: string;
        runId: string;
        iteration: number;
        lesson: string;
        bestScore: number | null;
    }[];
    summarizeRun(runId: string, goalId: string, status: string, startedAt: string, completedAt: string, allResults: ExperimentResult[]): RunSummary;
    getRunSummaries(goalId?: string): RunSummary[];
    getRun(runId: string): RunSummary | null;
    private _latencyStatsForRun;
    /**
     * Returns per-(arm family, task type, temperature) insights from all stored
     * experiment results. Task type is inferred from the goal question keywords.
     */
    getModelInsights(): ModelInsight[];
    /**
     * Returns aggregate statistics across all runs or a specific goal.
     */
    getAggregateStats(goalId?: string): AggregateStats;
    private _extractQuestionFromReport;
    close(): void;
}
export declare function calcLatencyStats(results: ExperimentResult[]): RunLatencyStats;
export interface AggregateStats {
    totalRuns: number;
    totalArmRuns: number;
    totalIterations: number;
    totalCostUsd: number;
    avgCostPerRun: number;
    avgScore: number | null;
    bestScore: number | null;
    bestArmId: string | null;
    bestRunId: string | null;
    avgLatencyMs: number | null;
    p50LatencyMs: number | null;
    p95LatencyMs: number | null;
    bestLatencyMs: number | null;
    bestLatencyArmId: string | null;
    runsByStatus: Record<string, number>;
    armsByModel: Record<string, number>;
    goalsStudied: number;
    avgIterationsPerRun: number | null;
}
//# sourceMappingURL=memory.d.ts.map