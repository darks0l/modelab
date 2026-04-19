import type { ResearchGoal, RunLog, ExperimentResult, ModelabConfig } from './types.js';
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
    /** Maximum acceptable TTFT (time-to-first-token) in ms.
     * Arms whose historical average TTFT exceeds this threshold are skipped
     * (unless they have no latency history yet).
     * Undefined/null means no filtering — all arms run regardless of speed. */
    latencyTargetMs?: number;
}
export declare class ResearchOrchestrator {
    private readonly models;
    private readonly budget;
    private readonly evalModelKey;
    private readonly parallelism;
    private readonly memory;
    private readonly cache?;
    private readonly onStream?;
    private readonly onArmComplete?;
    private readonly onProgress?;
    private readonly latencyTargetMs?;
    constructor(config: OrchestratorConfig);
    run(goal: ResearchGoal): Promise<RunLog>;
    private runArm;
    private printComparisonTable;
    private progress;
    /**
     * Returns true if an arm should be skipped this iteration because its
     * historical average TTFT exceeds the configured latencyTargetMs.
     * Arms with no latency history are allowed to run (we don't know yet).
     */
    private isArmTooSlow;
}
//# sourceMappingURL=orchestrator.d.ts.map