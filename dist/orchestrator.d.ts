import type { ResearchGoal, RunLog, ModelConfig } from './types.js';
import { ExperimentMemory } from './memory.js';
export interface OrchestratorConfig {
    models: Record<string, ModelConfig>;
    budget: {
        maxPerRun: number;
        maxPerExperiment: number;
        trackCosts: boolean;
    };
    evalModel: string;
    parallelism: number;
    memory?: ExperimentMemory;
}
export declare class ResearchOrchestrator {
    private readonly models;
    private readonly budget;
    private readonly evalModelKey;
    private readonly parallelism;
    private readonly memory;
    constructor(config: OrchestratorConfig);
    run(goal: ResearchGoal): Promise<RunLog>;
    private runArm;
}
//# sourceMappingURL=orchestrator.d.ts.map