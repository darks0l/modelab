export type ModelProvider = 'openai' | 'anthropic' | 'ollama' | 'openrouter' | 'minimax';
export interface ModelConfig {
    provider: ModelProvider;
    model: string;
    /** Optional provider-specific base URL (e.g. for OpenRouter or local Ollama) */
    baseUrl?: string;
    /** Optional Bearer token. Falls back to OPENAI_API_KEY / ANTHROPIC_API_KEY env vars. */
    apiKey?: string;
    maxTokens?: number;
    temperature?: number;
    costPerMillionInput?: number;
    costPerMillionOutput?: number;
}
export interface ModelBudget {
    maxPerRun: number;
    maxPerExperiment: number;
    trackCosts: boolean;
}
export interface ExperimentArm {
    id: string;
    name: string;
    /** Mustache-style template, e.g. "Research: {{question}}\n\nGoal: {{goal}}" */
    promptTemplate: string;
    /** Key into the models config, e.g. "balanced" */
    model: string;
    variables?: Record<string, string>;
}
export interface ExperimentResult {
    armId: string;
    output: string;
    /** 0–10 score from the evaluator */
    score: number | null;
    costUsd: number;
    tokensUsed: {
        input: number;
        output: number;
    };
    durationMs: number;
    timestamp: string;
    notes?: string;
    iteration: number;
}
export interface ResearchGoal {
    id: string;
    question: string;
    goal: string;
    qualityThreshold: number;
    maxIterations: number;
    arms: ExperimentArm[];
}
export interface RunLog {
    goalId: string;
    runId: string;
    status: 'running' | 'completed' | 'budget_exceeded' | 'quality_receeded' | 'failed';
    startedAt: string;
    completedAt?: string;
    totalCostUsd: number;
    bestResult?: ExperimentResult;
    allResults: ExperimentResult[];
}
export interface ModelabConfig {
    models: Record<string, ModelConfig>;
    budget: ModelBudget;
    evalModel: string;
    parallelism: number;
}
//# sourceMappingURL=types.d.ts.map