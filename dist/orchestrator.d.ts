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
    constructor(config: OrchestratorConfig);
    run(goal: ResearchGoal): Promise<RunLog>;
    private runArm;
    private printComparisonTable;
    private progress;
}
//# sourceMappingURL=orchestrator.d.ts.map