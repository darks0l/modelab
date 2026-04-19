/**
 * Campaign Manager — multi-run research orchestration for modelab.
 *
 * A campaign is a structured research project that runs multiple experiments
 * (via ResearchOrchestrator) to systematically explore a hypothesis or question.
 * Between runs, a synthesis engine aggregates interim findings and decides
 * what the next run should test.
 *
 * Stop conditions:
 * - max_runs reached
 * - quality threshold met across all remaining arms
 * - clear_answer: synthesis determines the hypothesis is decided
 * - convergence: scores plateau across consecutive runs
 */
import Database from 'better-sqlite3';
import type { ModelabConfig, ExperimentArm, ExperimentResult, RunLog } from './types.js';
export type CampaignStatus = 'planning' | 'running' | 'synthesizing' | 'complete' | 'paused' | 'failed';
export interface Campaign {
    id: string;
    question: string;
    hypothesis: string;
    status: CampaignStatus;
    findings: string;
    total_runs: number;
    max_runs: number;
    convergence_threshold: number;
    created_at: string;
    updated_at: string;
}
export interface CampaignRun {
    campaign_id: string;
    run_id: string;
    sequence_order: number;
    run_context: string;
    interim_finding: string;
    created_at: string;
}
export interface SynthesisResult {
    finding: string;
    belief_change: 'strengthened' | 'weakened' | 'unchanged' | 'inconclusive';
    next_run_recommendation: string | null;
    stop_reason: 'clear_answer' | 'max_runs' | 'converged' | 'budget_exceeded' | 'quality_reached' | null;
    confidence: number;
}
export declare class CampaignManager {
    /** @internal */
    db: Database.Database;
    private memory;
    private config;
    private evalModelKey;
    constructor(config: ModelabConfig);
    createCampaign(params: {
        question: string;
        hypothesis?: string;
        maxRuns?: number;
        convergenceThreshold?: number;
    }): Campaign;
    getCampaign(id: string): Campaign | null;
    listCampaigns(status?: CampaignStatus): Campaign[];
    pauseCampaign(id: string): Campaign | null;
    resumeCampaign(id: string): Campaign | null;
    deleteCampaign(id: string): void;
    /**
     * Run the next experiment in a campaign.
     *
     * Decides what to run based on:
     * 1. Prior runs' synthesis recommendations
     * 2. Model performance profiles (from model_profiles if available)
     * 3. What hasn't been tested yet
     *
     * After the run, synthesizes findings and decides whether to continue.
     */
    runNext(campaignId: string, arms: ExperimentArm[]): Promise<{
        campaign: Campaign;
        runLog: RunLog;
        synthesis: SynthesisResult;
    }>;
    /**
     * Force synthesis of all findings for a campaign (re-synthesize from scratch).
     */
    forceSynthesize(campaignId: string): Promise<SynthesisResult>;
    /**
     * Get the full campaign report — all runs, all findings, final synthesis.
     */
    getReport(campaignId: string): CampaignReport | null;
    private synthesize;
    private parseSynthesis;
    private ruleBasedSynthesis;
    /**
     * Build the "why we chose these arms" context for a campaign run.
     * Incorporates prior synthesis recommendations and model performance profiles.
     */
    private buildRunContext;
    private getCampaignRuns;
    close(): void;
}
export interface CampaignReport {
    campaign: Campaign;
    runs: RunReport[];
    totalCostUsd: number;
    totalRuns: number;
}
export interface RunReport {
    runId: string;
    sequenceOrder: number;
    runContext: string;
    finding: string;
    totalCostUsd: number;
    totalArms: number;
    bestArm: string | null;
    bestScore: number | null;
    results: ExperimentResult[];
}
/**
 * Built-in campaign: modelab self-improves by running experiments
 * to test "what code changes would most improve modelab's research quality?"
 *
 * This replaces raw cron iterations with a structured self-improvement loop.
 */
export declare const SELF_IMPROVEMENT_CAMPAIGN: {
    question: string;
    hypothesis: string;
    maxRuns: number;
    convergenceThreshold: number;
    /** Arms to test for self-improvement — variations on core system behavior */
    buildArms(): ExperimentArm[];
};
//# sourceMappingURL=campaign.d.ts.map