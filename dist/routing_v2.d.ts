/**
 * Learned Routing — v2
 *
 * Replaces the keyword-based router (router.ts) with a performance-based
 * routing system that uses actual model performance data and past run history.
 *
 * Key idea: routing should LEARN from past runs, not just match keywords.
 */
import type { ModelConfig } from './types.js';
import { ExperimentMemory } from './memory.js';
export type TaskType = 'reasoning' | 'code' | 'creative' | 'factual' | 'analysis' | 'general';
export interface TaskProfile {
    taskType: TaskType;
    /** 1-10 estimated complexity */
    complexity: number;
    latencyPriority: boolean;
    costPriority: boolean;
    /** Raw task text */
    raw: string;
}
export interface ModelProfile {
    key: string;
    provider: string;
    model: string;
    /** Average score across all runs for this model key */
    avgScore: number;
    /** Average latency (TTFT in ms) */
    avgLatencyMs: number | null;
    /** Average cost per run */
    avgCostUsd: number | null;
    /** Task types this model is strong at (inferred from history) */
    strengths: TaskType[];
    /** Task types this model is weak at */
    weaknesses: TaskType[];
    /** How many runs we've seen for this model */
    sampleSize: number;
}
export interface RoutingDecisionV2 {
    model: string;
    provider: string;
    reasoning: string;
    taskProfile: TaskProfile;
    /** Score breakdown per candidate model */
    candidates: ModelCandidate[];
    /** What the old keyword router would have chosen */
    fallbackDecision: {
        model: string;
        provider: string;
        reasoning: string;
    } | null;
}
export interface ModelCandidate {
    key: string;
    model: string;
    provider: string;
    score: number;
    /** Why this model scored this way */
    reason: string;
    /** Boost/penalty applied from history */
    historyBoost: number;
    /** Whether this was boosted by a similar past run */
    boostedByPastRun: boolean;
}
/** Infer task type from goal text */
export declare function inferTaskType(task: string): TaskType;
/** Build a full TaskProfile from goal text */
export declare function buildTaskProfile(task: string, mode?: 'quality' | 'latency' | 'cost'): TaskProfile;
/**
 * Route a task to the best-fit model using learned performance profiles.
 *
 * @param task           Goal/task text
 * @param modelConfigs   Available model configs (key → config)
 * @param mode           Routing mode: quality, latency, or cost
 * @param memory         Optional ExperimentMemory for history-based boosting
 * @returns              Full routing decision with reasoning
 */
export declare function routeTaskV2(task: string, modelConfigs: Record<string, ModelConfig>, mode?: 'quality' | 'latency' | 'cost', memory?: ExperimentMemory): RoutingDecisionV2;
/**
 * Pretty-print a routing decision for CLI output.
 */
export declare function formatRoutingDecisionV2(decision: RoutingDecisionV2): string;
/**
 * Format a model profile for CLI display.
 */
export declare function formatModelProfile(profile: ModelProfile): string;
//# sourceMappingURL=routing_v2.d.ts.map