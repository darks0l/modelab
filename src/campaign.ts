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
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { ResearchOrchestrator } from './orchestrator.js';
import { ExperimentMemory } from './memory.js';
import { Cache } from './cache.js';
import { scoreOutput } from './scorer.js';
import { callModel } from './evaluator.js';
import type {
  ModelabConfig,
  ResearchGoal,
  ExperimentArm,
  ExperimentResult,
  RunLog,
} from './types.js';
import type { ModelConfig } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type CampaignStatus =
  | 'planning'   // Created, not started
  | 'running'    // Actively running experiments
  | 'synthesizing' // Between runs, synthesizing findings
  | 'complete'   // Finished (stop condition met)
  | 'paused'     // Manually paused
  | 'failed';    // Error state

export interface Campaign {
  id: string;
  question: string;
  hypothesis: string;
  status: CampaignStatus;
  findings: string;          // Synthesized final conclusion
  total_runs: number;        // How many runs completed
  max_runs: number;          // Cap
  convergence_threshold: number; // Score spread below which we call it converged
  created_at: string;
  updated_at: string;
}

export interface CampaignRun {
  campaign_id: string;
  run_id: string;
  sequence_order: number;    // Which run number this is (1-indexed)
  run_context: string;       // Why this particular configuration was chosen
  interim_finding: string;  // What this run told us
  created_at: string;
}

export interface SynthesisResult {
  finding: string;           // What this run told us
  belief_change: 'strengthened' | 'weakened' | 'unchanged' | 'inconclusive';
  next_run_recommendation: string | null;  // What to test next, or null to stop
  stop_reason: 'clear_answer' | 'max_runs' | 'converged' | 'budget_exceeded' | 'quality_reached' | null;
  confidence: number;        // 0-1, how confident we are in the hypothesis
}

// ── DB ──────────────────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), '.modelab');
const DB_PATH = join(DATA_DIR, 'memory.db');

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function openDb(): Database.Database {
  ensureDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id                  TEXT PRIMARY KEY,
      question            TEXT NOT NULL,
      hypothesis          TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL DEFAULT 'planning',
      findings            TEXT NOT NULL DEFAULT '',
      total_runs          INTEGER NOT NULL DEFAULT 0,
      max_runs            INTEGER NOT NULL DEFAULT 5,
      convergence_threshold REAL NOT NULL DEFAULT 1.5,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS campaign_runs (
      campaign_id         TEXT NOT NULL,
      run_id              TEXT NOT NULL,
      sequence_order      INTEGER NOT NULL,
      run_context         TEXT NOT NULL DEFAULT '',
      interim_finding     TEXT NOT NULL DEFAULT '',
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (campaign_id, run_id),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_campaign_status ON campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_campaign_runs_campaign ON campaign_runs(campaign_id);
  `);
  return db;
}

// ── Synthesis Prompt ─────────────────────────────────────────────────────────

const SYNTHESIS_PROMPT = `You are a research synthesis agent. Given a research question, a hypothesis, and results from a series of experiment runs, produce a concise synthesis.

Research Question: {{question}}
Hypothesis: {{hypothesis}}

Prior Runs Summary:
{{prior_runs}}

Latest Run Result:
- Run #{{run_number}} arm results:
{{arm_results}}

Analyze:
1. What did this run tell us? Did it support or refute the hypothesis?
2. How does it change our belief about the hypothesis? (strengthened / weakened / unchanged / inconclusive)
3. What should the next run test? Be specific — which models, temperatures, angles?
4. Should we stop? Consider: clear answer found, scores converged across runs, max runs reached.

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "finding": "1-2 sentence summary of what this run revealed",
  "belief_change": "strengthened|weakened|unchanged|inconclusive",
  "next_run_recommendation": "Specific recommendation for the next run, or null if you recommend stopping",
  "stop_reason": "clear_answer|max_runs|converged|budget_exceeded|quality_reached|null",
  "confidence": 0.0-1.0 (your confidence that the hypothesis is correct or that more runs won't change the conclusion)
}`;

// ── CampaignManager ─────────────────────────────────────────────────────────

export class CampaignManager {
  /** @internal */
  db: Database.Database;
  private memory: ExperimentMemory;
  private config: ModelabConfig;
  private evalModelKey: string;

  constructor(config: ModelabConfig) {
    this.db = openDb();
    this.memory = new ExperimentMemory();
    this.config = config;
    this.evalModelKey = config.evalModel;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  createCampaign(params: {
    question: string;
    hypothesis?: string;
    maxRuns?: number;
    convergenceThreshold?: number;
  }): Campaign {
    const id = `camp-${Date.now()}-${(crypto.randomUUID as () => string)().slice(0, 8)}`;
    const now = new Date().toISOString();
    const maxRuns = params.maxRuns ?? 5;
    const convThreshold = params.convergenceThreshold ?? 1.5;

    const stmt = this.db.prepare(`
      INSERT INTO campaigns (id, question, hypothesis, status, findings, total_runs, max_runs, convergence_threshold, created_at, updated_at)
      VALUES (?, ?, ?, 'planning', '', 0, ?, ?, ?, ?)
    `);
    stmt.run(id, params.question, params.hypothesis ?? '', maxRuns, convThreshold, now, now);

    return {
      id,
      question: params.question,
      hypothesis: params.hypothesis ?? '',
      status: 'planning',
      findings: '',
      total_runs: 0,
      max_runs: maxRuns,
      convergence_threshold: convThreshold,
      created_at: now,
      updated_at: now,
    };
  }

  getCampaign(id: string): Campaign | null {
    const row = this.db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id) as CampaignRow | undefined;
    return row ? mapCampaignRow(row) : null;
  }

  listCampaigns(status?: CampaignStatus): Campaign[] {
    const sql = status
      ? `SELECT * FROM campaigns WHERE status = ? ORDER BY created_at DESC`
      : `SELECT * FROM campaigns ORDER BY created_at DESC`;
    const rows = (status
      ? this.db.prepare(sql).all(status)
      : this.db.prepare(sql).all()) as CampaignRow[];
    return rows.map(mapCampaignRow);
  }

  pauseCampaign(id: string): Campaign | null {
    this.db.prepare(`UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?`).run(id);
    return this.getCampaign(id);
  }

  resumeCampaign(id: string): Campaign | null {
    const c = this.getCampaign(id);
    if (!c) return null;
    const validResume = c.status === 'paused' || c.status === 'synthesizing';
    if (!validResume) return c;
    this.db.prepare(`UPDATE campaigns SET status = 'running', updated_at = datetime('now') WHERE id = ?`).run(id);
    return this.getCampaign(id);
  }

  deleteCampaign(id: string): void {
    this.db.prepare(`DELETE FROM campaigns WHERE id = ?`).run(id);
  }

  // ── Run ──────────────────────────────────────────────────────────────────

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
  async runNext(campaignId: string, arms: ExperimentArm[]): Promise<{
    campaign: Campaign;
    runLog: RunLog;
    synthesis: SynthesisResult;
  }> {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
    if (campaign.status === 'complete' || campaign.status === 'failed') {
      throw new Error(`Campaign ${campaignId} is already ${campaign.status}`);
    }

    // Update status to running
    this.db.prepare(`UPDATE campaigns SET status = 'running', updated_at = datetime('now') WHERE id = ?`).run(campaignId);

    const runNumber = campaign.total_runs + 1;
    const priorRuns = this.getCampaignRuns(campaignId);

    // Build run context — why are we running these arms?
    const runContext = this.buildRunContext(campaign, priorRuns, arms);

    // Create the experiment goal
    const goalId = `camp-${campaignId}-run-${runNumber}`;
    const goal: ResearchGoal = {
      id: goalId,
      question: campaign.question,
      goal: campaign.question,
      qualityThreshold: 7,
      maxIterations: 2,
      arms,
    };

    // Run the experiment
    const cache = new Cache(7 * 24 * 60 * 60 * 1000);
    const orchestrator = new ResearchOrchestrator({
      models: this.config.models,
      budget: this.config.budget,
      evalModel: this.evalModelKey,
      parallelism: this.config.parallelism,
      memory: this.memory,
      cache,
    });

    const runLog = await orchestrator.run(goal);

    // Synthesize findings
    const synthesis = await this.synthesize(campaign, runLog, priorRuns, runNumber);

    // Record this run
    const runId = runLog.runId;
    const stmt = this.db.prepare(`
      INSERT INTO campaign_runs (campaign_id, run_id, sequence_order, run_context, interim_finding, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(campaignId, runId, runNumber, runContext, synthesis.finding);

    // Update campaign
    const newTotal = campaign.total_runs + 1;
    const now = new Date().toISOString();
    let newStatus: CampaignStatus = 'running';
    let stopReason = synthesis.stop_reason;

    if (stopReason && stopReason !== 'quality_reached') {
      newStatus = 'complete';
    } else if (newTotal >= campaign.max_runs) {
      newStatus = 'complete';
      stopReason = 'max_runs';
    } else if (synthesis.stop_reason === 'quality_reached') {
      // Keep running — quality reached doesn't mean campaign is done
      newStatus = 'running';
    }

    this.db.prepare(`
      UPDATE campaigns
      SET total_runs = ?, status = ?, findings = ?, updated_at = ?
      WHERE id = ?
    `).run(newTotal, newStatus, synthesis.finding, now, campaignId);

    // Also store in campaign_runs the full finding as an update to interim_finding for the latest run
    this.db.prepare(`
      UPDATE campaign_runs SET interim_finding = ? WHERE campaign_id = ? AND run_id = ?
    `).run(synthesis.finding, campaignId, runId);

    const updatedCampaign = this.getCampaign(campaignId)!;

    return { campaign: updatedCampaign, runLog, synthesis };
  }

  /**
   * Force synthesis of all findings for a campaign (re-synthesize from scratch).
   */
  async forceSynthesize(campaignId: string): Promise<SynthesisResult> {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

    const priorRuns = this.getCampaignRuns(campaignId);
    const allResults = priorRuns.flatMap(cr => {
      const history = this.memory.getHistory().filter(r => r.runId === cr.run_id);
      return history;
    });

    const runLog: RunLog = {
      goalId: campaign.id,
      runId: `synthesis-${campaignId}`,
      status: 'completed',
      startedAt: campaign.created_at,
      completedAt: new Date().toISOString(),
      totalCostUsd: allResults.reduce((s, r) => s + r.costUsd, 0),
      bestResult: allResults.reduce((b, r) => !b || (r.score !== null && r.score > (b.score ?? 0)) ? r : b, allResults[0]),
      allResults,
    };

    const synthesis = await this.synthesize(campaign, runLog, priorRuns, priorRuns.length);
    this.db.prepare(`UPDATE campaigns SET findings = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(synthesis.finding, campaignId);

    return synthesis;
  }

  /**
   * Get the full campaign report — all runs, all findings, final synthesis.
   */
  getReport(campaignId: string): CampaignReport | null {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) return null;

    const runs = this.getCampaignRuns(campaignId);
    const runReports = runs.map(run => {
      const history = this.memory.getHistory().filter(r => r.runId === run.run_id);
      const best = history.reduce((b, r) => !b || (r.score !== null && r.score > (b.score ?? 0)) ? r : b, history[0]);
      return {
        runId: run.run_id,
        sequenceOrder: run.sequence_order,
        runContext: run.run_context,
        finding: run.interim_finding,
        totalCostUsd: history.reduce((s, r) => s + r.costUsd, 0),
        totalArms: history.length,
        bestArm: best?.armId ?? null,
        bestScore: best?.score ?? null,
        results: history,
      };
    });

    return {
      campaign,
      runs: runReports,
      totalCostUsd: runReports.reduce((s, r) => s + r.totalCostUsd, 0),
      totalRuns: runs.length,
    };
  }

  // ── Synthesis Engine ──────────────────────────────────────────────────────

  private async synthesize(
    campaign: Campaign,
    runLog: RunLog,
    priorRuns: CampaignRun[],
    runNumber: number
  ): Promise<SynthesisResult> {
    const scored = runLog.allResults.filter(r => r.score !== null);

    if (scored.length === 0) {
      return {
        finding: 'No scored results — unable to assess hypothesis.',
        belief_change: 'inconclusive',
        next_run_recommendation: 'Re-run with a different model configuration.',
        stop_reason: 'budget_exceeded',
        confidence: 0,
      };
    }

    const best = scored.reduce((b, r) => !b || (r.score ?? 0) > (b.score ?? 0) ? r : b, scored[0]);
    const worst = scored.reduce((w, r) => !w || (r.score ?? 0) < (w.score ?? 0) ? r : w, scored[0]);
    const spread = best.score! - worst.score!;

    // Build prior runs summary for the LLM prompt
    const priorSummary = priorRuns.length > 0
      ? priorRuns.map(r => `Run #${r.sequence_order}: ${r.interim_finding}`).join('\n')
      : 'No prior runs yet.';

    // Build arm results for LLM
    const armResults = runLog.allResults
      .map(r => `- ${r.armId} (${r.model}): score=${r.score ?? 'N/A'}, cost=$${r.costUsd.toFixed(4)}, latency=${r.latencyMs}ms`)
      .join('\n');

    const evalConfig = this.config.models[this.evalModelKey];
    if (!evalConfig) {
      // Fallback to rule-based synthesis when no eval model
      return this.ruleBasedSynthesis(campaign, runLog, priorRuns, runNumber, spread, best, worst);
    }

    try {
      const prompt = SYNTHESIS_PROMPT
        .replace('{{question}}', campaign.question)
        .replace('{{hypothesis}}', campaign.hypothesis || 'No specific hypothesis — exploratory research.')
        .replace('{{prior_runs}}', priorSummary)
        .replace('{{run_number}}', String(runNumber))
        .replace('{{arm_results}}', armResults);

      const raw = await callModel(evalConfig, prompt);
      return this.parseSynthesis(raw, best, worst, spread, campaign, runNumber, priorRuns);
    } catch (err) {
      console.warn(`[campaign] Synthesis LLM call failed, using rule-based fallback: ${err}`);
      return this.ruleBasedSynthesis(campaign, runLog, priorRuns, runNumber, spread, best, worst);
    }
  }

  private parseSynthesis(
    raw: string,
    best: ExperimentResult,
    worst: ExperimentResult,
    spread: number,
    campaign: Campaign,
    runNumber: number,
    priorRuns: CampaignRun[],
  ): SynthesisResult {
    try {
      const jsonMatch = raw.match(/```json\s*(\{[\s\S]*?\})\s*```|```\s*(\{[\s\S]*?\})\s*```|(\{[\s\S]*?\})/s);
      let jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[2] ?? jsonMatch[3]) : raw;
      const start = jsonStr.indexOf('{');
      const end = jsonStr.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        jsonStr = jsonStr.slice(start, end + 1);
      }
      const parsed = JSON.parse(jsonStr);

      const beliefChange = ['strengthened', 'weakened', 'unchanged', 'inconclusive'].includes(parsed.belief_change)
        ? parsed.belief_change
        : 'inconclusive';
      const stopReason = ['clear_answer', 'max_runs', 'converged', 'budget_exceeded', 'quality_reached', null].includes(parsed.stop_reason)
        ? parsed.stop_reason
        : null;
      const confidence = Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0.5));

      // Override stop if spread indicates convergence
      if (spread < campaign.convergence_threshold && priorRuns.length >= 2) {
        return {
          finding: parsed.finding ?? `Best: ${best.armId} scored ${best.score}/10. Spread: ${spread.toFixed(1)}`,
          belief_change: beliefChange,
          next_run_recommendation: null,
          stop_reason: 'converged',
          confidence: Math.min(1, confidence + 0.1),
        };
      }

      return {
        finding: parsed.finding ?? `Run #${runNumber}: ${best.armId} scored ${best.score}/10.`,
        belief_change: beliefChange,
        next_run_recommendation: parsed.next_run_recommendation ?? null,
        stop_reason: stopReason,
        confidence,
      };
    } catch {
      return this.ruleBasedSynthesis(campaign, {} as RunLog, priorRuns, runNumber, spread, best, worst);
    }
  }

  private ruleBasedSynthesis(
    campaign: Campaign,
    runLog: RunLog,
    priorRuns: CampaignRun[],
    runNumber: number,
    spread: number,
    best: ExperimentResult,
    worst: ExperimentResult,
  ): SynthesisResult {
    const scored = runLog.allResults.filter(r => r.score !== null);

    // Convergence check
    if (spread < campaign.convergence_threshold && priorRuns.length >= 2) {
      return {
        finding: `Scores converged (spread ${spread.toFixed(1)} < ${campaign.convergence_threshold}). ${best.armId} best at ${best.score}/10.`,
        belief_change: 'unchanged',
        next_run_recommendation: null,
        stop_reason: 'converged',
        confidence: 0.8,
      };
    }

    // High quality reached
    if (best.score! >= campaign.convergence_threshold * 4) {
      return {
        finding: `Strong support: ${best.armId} scored ${best.score}/10.`,
        belief_change: 'strengthened',
        next_run_recommendation: null,
        stop_reason: 'clear_answer',
        confidence: 0.9,
      };
    }

    // Low scores — hypothesis weakened
    if (best.score! < 4) {
      return {
        finding: `No arm scored above 4/10. Hypothesis appears weak. Best: ${best.armId} at ${best.score}/10.`,
        belief_change: 'weakened',
        next_run_recommendation: 'Try different models or reframe the question.',
        stop_reason: null,
        confidence: 0.7,
      };
    }

    // Default: keep exploring
    return {
      finding: `Best: ${best.armId} (${best.score}/10). Worst: ${worst.armId} (${worst.score}/10). Spread: ${spread.toFixed(1)}.`,
      belief_change: 'unchanged',
      next_run_recommendation: scored.length > 1
        ? `Try the lower-scoring models with higher temperature or different prompts.`
        : `Run additional model arms to compare.`,
      stop_reason: null,
      confidence: 0.4,
    };
  }

  // ── Run Context Builder ──────────────────────────────────────────────────

  /**
   * Build the "why we chose these arms" context for a campaign run.
   * Incorporates prior synthesis recommendations and model performance profiles.
   */
  private buildRunContext(
    campaign: Campaign,
    priorRuns: CampaignRun[],
    arms: ExperimentArm[],
  ): string {
    const parts: string[] = [];

    parts.push(`Campaign: ${campaign.id} (run #${priorRuns.length + 1}/${campaign.max_runs})`);
    parts.push(`Question: ${campaign.question}`);
    if (campaign.hypothesis) parts.push(`Hypothesis: ${campaign.hypothesis}`);

    if (priorRuns.length > 0) {
      const lastRun = priorRuns[priorRuns.length - 1];
      parts.push(`Prior finding (run #${lastRun.sequence_order}): ${lastRun.interim_finding}`);
      if (lastRun.run_context) {
        parts.push(`Prior context: ${lastRun.run_context}`);
      }
    }

    parts.push(`This run's arms: ${arms.map(a => `${a.id} (${a.model})`).join(', ')}`);

    return parts.join(' | ');
  }

  private getCampaignRuns(campaignId: string): CampaignRun[] {
    const rows = this.db.prepare(
      `SELECT * FROM campaign_runs WHERE campaign_id = ? ORDER BY sequence_order ASC`
    ).all(campaignId) as CampaignRunRow[];
    return rows.map(r => ({
      campaign_id: r.campaign_id,
      run_id: r.run_id,
      sequence_order: r.sequence_order,
      run_context: r.run_context ?? '',
      interim_finding: r.interim_finding ?? '',
      created_at: r.created_at,
    }));
  }

  close(): void {
    this.db.close();
    this.memory.close();
  }
}

// ── Report Types ────────────────────────────────────────────────────────────

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

// ── DB Row types ────────────────────────────────────────────────────────────

interface CampaignRow {
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

interface CampaignRunRow {
  campaign_id: string;
  run_id: string;
  sequence_order: number;
  run_context: string;
  interim_finding: string;
  created_at: string;
}

function mapCampaignRow(r: CampaignRow): Campaign {
  return {
    id: r.id,
    question: r.question,
    hypothesis: r.hypothesis,
    status: r.status,
    findings: r.findings,
    total_runs: r.total_runs,
    max_runs: r.max_runs,
    convergence_threshold: r.convergence_threshold,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ── Self-Improvement Campaign ───────────────────────────────────────────────

/**
 * Built-in campaign: modelab self-improves by running experiments
 * to test "what code changes would most improve modelab's research quality?"
 *
 * This replaces raw cron iterations with a structured self-improvement loop.
 */
export const SELF_IMPROVEMENT_CAMPAIGN = {
  question: 'What code changes would most improve modelab\'s research quality?',
  hypothesis: 'Prompt engineering + routing improvements yield better research quality than adding new model providers.',
  maxRuns: 6,
  convergenceThreshold: 1.0,

  /** Arms to test for self-improvement — variations on core system behavior */
  buildArms(): ExperimentArm[] {
    return [
      {
        id: 'self-prompt-v1',
        name: 'Self-improvement: Prompt strategy v1',
        promptTemplate: `You are a research agent following modelab's structured methodology.

Goal: {{goal}}
Question: {{question}}

{{iteration_context}}

Provide a thorough, well-reasoned response. Structure your answer with:
1. Hypothesis
2. Evidence
3. Counterarguments
4. Conclusion`,
        model: 'balanced',
      },
      {
        id: 'self-prompt-v2',
        name: 'Self-improvement: Prompt strategy v2 (concise)',
        promptTemplate: `{{goal}}

Question: {{question}}

{{iteration_context}}

Be concise and direct. Prioritize accuracy over length.`,
        model: 'balanced',
      },
      {
        id: 'self-reasoning',
        name: 'Self-improvement: Reasoning-focused',
        promptTemplate: `{{goal}}

Question: {{question}}

{{iteration_context}}

Think step-by-step. Evaluate multiple perspectives before concluding.`,
        model: 'reasoning',
      },
    ];
  },
};
