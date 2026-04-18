import type { ExperimentResult } from './types.js';
export declare class ExperimentMemory {
    private db;
    constructor();
    log(result: ExperimentResult, runId: string, goalId: string): void;
    getHistory(goalId?: string): ExperimentResult[];
    getBest(goalId: string): ExperimentResult | null;
    getAverageScore(goalId: string): number | null;
    getTotalSpend(goalId?: string): number;
    close(): void;
}
//# sourceMappingURL=memory.d.ts.map