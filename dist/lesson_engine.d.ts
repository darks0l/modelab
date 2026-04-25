/**
 * lesson_engine.ts — v0.4
 *
 * The self-iteration engine that closes the loop:
 *   run → score → apply lesson → next run uses adjusted behavior
 *
 * This is NOT advisory text. Lessons become actual config changes:
 *   - Router weight adjustments (model_profiles)
 *   - Temperature overrides (router_adjustments)
 *   - Threshold changes (applied_lessons)
 *
 * The orchestrator calls `applyLessons()` after each run.
 * The router reads model_profiles + router_adjustments BEFORE deciding which model to use.
 */
import Database from 'better-sqlite3';
export interface LessonApplication {
    id?: number;
    lessonText: string;
    applicationType: 'router_adjustment' | 'threshold_change' | 'template_mod';
    targetComponent: string;
    changeMade: Record<string, unknown>;
    effectivenessScore: number | null;
    createdAt?: string;
}
export interface ModelProfile {
    modelKey: string;
    avgScore: number;
    avgLatencyMs: number | null;
    avgCostUsd: number | null;
    runsCount: number;
    strengths: string[];
    weaknesses: string[];
    lastUpdated: string;
}
export interface RouterAdjustment {
    id?: number;
    modelKey: string;
    adjustmentType: 'score_delta' | 'weight_boost' | 'temp_override';
    delta: number;
    reason: string;
    createdAt?: string;
    expiresAt: string | null;
}
export interface ModelAdvice {
    modelKey: string;
    adjustmentType: 'score_delta' | 'weight_boost' | 'temp_override';
    delta: number;
    reason: string;
}
export interface ResolvedAdjustment {
    modelKey: string;
    /** The primary type of the most recent adjustment (for display only) */
    adjustmentType: 'score_delta' | 'weight_boost' | 'temp_override' | null;
    delta: number;
    reason: string;
    createdAt?: string;
    expiresAt: string | null;
    /** Computed effective score delta for this model in current context */
    effectiveScore?: number;
    /** Computed temperature override value */
    temperatureOverride?: number;
}
/**
 * Get (or create) the singleton LessonEngine instance backed by the main modelab DB.
 */
export declare function getLessonEngine(): LessonEngine;
/** For testing only — creates an isolated instance on a custom DB path. */
export declare function getLessonEngineForTest(dbPath: string): LessonEngine;
/** Reset the singleton — call between tests. */
export declare function resetLessonEngine(): void;
export declare class LessonEngine {
    private readonly db;
    private readonly isTestInstance;
    constructor(db: Database.Database, isTestInstance?: boolean);
    private initSchema;
    /**
     * Update model_profiles after a run completes.
     * Called by the orchestrator once per run (not per arm).
     *
     * @param results  All arm results from this run
     * @param question  The research question (used to infer task type for strengths/weaknesses)
     */
    updateProfiles(results: Array<{
        model: string;
        score: number | null;
        costUsd: number;
        latencyMs: number;
        armId: string;
    }>, question: string): void;
    /**
     * Get the current profile for a model key.
     */
    getProfile(modelKey: string): ModelProfile | null;
    /**
     * Get all model profiles, sorted by avg_score descending.
     */
    getAllProfiles(): ModelProfile[];
    /**
     * Write a router adjustment after scoring. Called by the scorer/policy engine.
     *
     * @param modelKey   e.g. "balanced", "claude-sonnet"
     * @param type       'score_delta' | 'weight_boost' | 'temp_override'
     * @param delta      The adjustment value (e.g. -1.5 for score, +0.3 for weight, 0.7 for temp)
     * @param reason     Human-readable reason
     * @param expiresAt  ISO string — null means never expires
     */
    writeAdjustment(modelKey: string, type: RouterAdjustment['adjustmentType'], delta: number, reason: string, expiresAt?: string | null): void;
    /**
     * Get all active (non-expired) adjustments for a model.
     */
    getActiveAdjustments(modelKey: string): RouterAdjustment[];
    /**
     * Get the resolved adjustment effects for a model:
     * - sum of score_delta adjustments
     * - sum of weight_boost adjustments
     * - latest temp_override value (if any)
     */
    resolveAdjustments(modelKey: string): ResolvedAdjustment;
    /**
     * Parse a lesson string and apply it as an actual system change.
     *
     * Examples of lessons that get applied:
     * - "GLM-5.0 performs poorly on code tasks below 0.7 temp" → score_delta -1.5 on glm5 for code tasks
     * - "Anthropic Sonnet outperforms GPT-4 on reasoning"       → weight_boost +0.5 on claude-sonnet
     * - "use temperature 0.7 for reasoning tasks"               → temp_override 0.7 for reasoning model
     */
    applyLesson(lessonText: string, context: {
        modelKey?: string;
        taskType?: string;
        score?: number;
        temperature?: number;
    }): LessonApplication | null;
    /**
     * Record that a lesson was applied (or that it couldn't be parsed).
     */
    private recordApplication;
    /**
     * Mark a previously applied lesson's effectiveness score.
     * Called on the NEXT run after a lesson was applied.
     * Higher score = the lesson's adjustment helped.
     */
    setLessonEffectiveness(lessonId: number, score: number): void;
    /**
     * Get the effectiveness history of applied lessons.
     */
    getAppliedLessons(limit?: number): LessonApplication[];
    /**
     * Called by the orchestrator after a run.
     * Parses the lesson text and applies any actionable adjustments.
     * Returns all applied lessons.
     */
    processRunLesson(lessonText: string, runContext: {
        modelKey?: string;
        taskType?: string;
        score?: number;
        temperature?: number;
    }): LessonApplication[];
    /**
     * Read back router adjustments for a given task type and return actionable advice
     * for the next iteration. This closes the self-iteration loop: lessons learned are
     * applied to subsequent arm selection.
     */
    getAdvice(taskType: string | undefined): ModelAdvice[];
    private _modelNameToKey;
    close(): void;
}
//# sourceMappingURL=lesson_engine.d.ts.map