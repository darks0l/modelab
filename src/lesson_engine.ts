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
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync } from 'fs';

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

// ── DB setup ─────────────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), '.modelab');
const DB_PATH = join(DATA_DIR, 'memory.db');

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function openDb(): Database.Database {
  ensureDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: LessonEngine | null = null;

/**
 * Get (or create) the singleton LessonEngine instance backed by the main modelab DB.
 */
export function getLessonEngine(): LessonEngine {
  if (!_instance) {
    _instance = new LessonEngine(openDb());
  }
  return _instance;
}

/** For testing only — creates an isolated instance on a custom DB path. */
export function getLessonEngineForTest(dbPath: string): LessonEngine {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return new LessonEngine(db, true);
}

/** Reset the singleton — call between tests. */
export function resetLessonEngine(): void {
  _instance?.close();
  _instance = null;
}

// ── Keyword extractors ───────────────────────────────────────────────────────

const CODE_KEYWORDS = /\b(code|function|refactor|bug|fix|test|build|repo|pull.?request|pr|typescript|javascript|python|rust|compile|lint|eslint|prettier|npm|yarn|cargo)\b/i;
const REASON_KEYWORDS = /\b(reason|proof|logic|analysis|analyze|theorem|prove|conjecture|derive|evaluate|compare|contrast|critique|synthesis|reasoning(?:\.step)?|step\.by\.step|explain why)\b/i;
const GLM_MODEL_KEYWORDS = /\b(glm-(?:5|4\.7|5\.1|5\.0)|glm(?:5|4\.7|5\.1|5\.0|4))\b/i;
const QUICK_KEYWORDS = /\b(quick|small|summary|brief|one.?liner|quick.?summary|what is|define|lookup)\b/i;

function inferTaskType(question: string): string {
  if (CODE_KEYWORDS.test(question)) return 'coding';
  if (REASON_KEYWORDS.test(question) || GLM_MODEL_KEYWORDS.test(question)) return 'reasoning';
  if (QUICK_KEYWORDS.test(question)) return 'quick';
  return 'balanced';
}

// ── Lesson Engine ────────────────────────────────────────────────────────────

export class LessonEngine {
  private readonly db: Database.Database;
  private readonly isTestInstance: boolean;

  constructor(db: Database.Database, isTestInstance = false) {
    this.db = db;
    this.isTestInstance = isTestInstance;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_profiles (
        model_key        TEXT PRIMARY KEY,
        avg_score        REAL    NOT NULL DEFAULT 5.0,
        avg_latency_ms   REAL,
        avg_cost_usd     REAL,
        runs_count       INTEGER NOT NULL DEFAULT 0,
        strengths        TEXT    NOT NULL DEFAULT '[]',
        weaknesses       TEXT    NOT NULL DEFAULT '[]',
        last_updated     TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS router_adjustments (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        model_key        TEXT    NOT NULL,
        adjustment_type  TEXT    NOT NULL,
        delta            REAL    NOT NULL,
        reason           TEXT    NOT NULL DEFAULT '',
        created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        expires_at       TEXT
      );

      CREATE TABLE IF NOT EXISTS applied_lessons (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        lesson_text      TEXT    NOT NULL,
        application_type TEXT    NOT NULL,
        target_component TEXT    NOT NULL,
        change_made      TEXT    NOT NULL,
        effectiveness_score REAL,
        created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Expire old adjustments on startup
    this.db.prepare(`DELETE FROM router_adjustments WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
  }

  // ── Profile management ─────────────────────────────────────────────────────

  /**
   * Update model_profiles after a run completes.
   * Called by the orchestrator once per run (not per arm).
   *
   * @param results  All arm results from this run
   * @param question  The research question (used to infer task type for strengths/weaknesses)
   */
  updateProfiles(
    results: Array<{
      model: string; // model config key, e.g. "balanced", "fast"
      score: number | null;
      costUsd: number;
      latencyMs: number;
      armId: string;
    }>,
    question: string
  ): void {
    const taskType = inferTaskType(question);

    for (const r of results) {
      if (r.score === null) continue;

      const existing = this.db.prepare(
        `SELECT avg_score, avg_latency_ms, avg_cost_usd, runs_count, strengths, weaknesses FROM model_profiles WHERE model_key = ?`
      ).get(r.model) as { avg_score: number; avg_latency_ms: number | null; avg_cost_usd: number | null; runs_count: number; strengths: string; weaknesses: string } | undefined;

      // Maintain running averages using existing DB values + new data
      const prevLatency = existing?.avg_latency_ms ?? null;
      const prevCost = existing?.avg_cost_usd ?? null;
      const prevRuns = existing?.runs_count ?? 0;
      const newLatency = r.latencyMs > 0
        ? (prevLatency !== null ? ((prevLatency * prevRuns) + r.latencyMs) / (prevRuns + 1) : r.latencyMs)
        : prevLatency;
      const newCost = prevCost !== null
        ? ((prevCost * prevRuns) + r.costUsd) / (prevRuns + 1)
        : r.costUsd;

      if (existing) {
        const newCount = existing.runs_count + 1;
        const newAvg = ((existing.avg_score * existing.runs_count) + r.score) / newCount;
        const strengths: string[] = JSON.parse(existing.strengths);
        const weaknesses: string[] = JSON.parse(existing.weaknesses);

        // Infer and record strengths/weaknesses based on score and task type
        if (r.score >= 7) {
          if (!strengths.includes(taskType)) strengths.push(taskType);
        } else if (r.score < 5) {
          if (!weaknesses.includes(taskType)) weaknesses.push(taskType);
        }

        this.db.prepare(`
          UPDATE model_profiles
          SET avg_score = ?, runs_count = ?, strengths = ?, weaknesses = ?,
              avg_latency_ms = ?, avg_cost_usd = ?,
              last_updated = datetime('now')
          WHERE model_key = ?
        `).run(newAvg, newCount, JSON.stringify(strengths), JSON.stringify(weaknesses),
          newLatency, newCost, r.model);
      } else {
        const strengths: string[] = r.score >= 7 ? [taskType] : [];
        const weaknesses: string[] = r.score < 5 ? [taskType] : [];

        this.db.prepare(`
          INSERT INTO model_profiles (model_key, avg_score, avg_latency_ms, avg_cost_usd, runs_count, strengths, weaknesses)
          VALUES (?, ?, ?, ?, 1, ?, ?)
        `).run(r.model, r.score, newLatency, newCost,
          JSON.stringify(strengths), JSON.stringify(weaknesses));
      }
    }
  }

  /**
   * Get the current profile for a model key.
   */
  getProfile(modelKey: string): ModelProfile | null {
    const row = this.db.prepare(`SELECT * FROM model_profiles WHERE model_key = ?`).get(modelKey) as {
      model_key: string; avg_score: number; avg_latency_ms: number | null;
      avg_cost_usd: number | null; runs_count: number;
      strengths: string; weaknesses: string; last_updated: string;
    } | undefined;
    if (!row) return null;
    return {
      modelKey: row.model_key,
      avgScore: row.avg_score,
      avgLatencyMs: row.avg_latency_ms,
      avgCostUsd: row.avg_cost_usd,
      runsCount: row.runs_count,
      strengths: JSON.parse(row.strengths),
      weaknesses: JSON.parse(row.weaknesses),
      lastUpdated: row.last_updated,
    };
  }

  /**
   * Get all model profiles, sorted by avg_score descending.
   */
  getAllProfiles(): ModelProfile[] {
    const rows = this.db.prepare(
      `SELECT * FROM model_profiles ORDER BY avg_score DESC`
    ).all() as Array<{
      model_key: string; avg_score: number; avg_latency_ms: number | null;
      avg_cost_usd: number | null; runs_count: number;
      strengths: string; weaknesses: string; last_updated: string;
    }>;
    return rows.map(row => ({
      modelKey: row.model_key,
      avgScore: row.avg_score,
      avgLatencyMs: row.avg_latency_ms,
      avgCostUsd: row.avg_cost_usd,
      runsCount: row.runs_count,
      strengths: JSON.parse(row.strengths),
      weaknesses: JSON.parse(row.weaknesses),
      lastUpdated: row.last_updated,
    }));
  }

  // ── Router adjustments ─────────────────────────────────────────────────────

  /**
   * Write a router adjustment after scoring. Called by the scorer/policy engine.
   *
   * @param modelKey   e.g. "balanced", "claude-sonnet"
   * @param type       'score_delta' | 'weight_boost' | 'temp_override'
   * @param delta      The adjustment value (e.g. -1.5 for score, +0.3 for weight, 0.7 for temp)
   * @param reason     Human-readable reason
   * @param expiresAt  ISO string — null means never expires
   */
  writeAdjustment(
    modelKey: string,
    type: RouterAdjustment['adjustmentType'],
    delta: number,
    reason: string,
    expiresAt: string | null = null
  ): void {
    this.db.prepare(`
      INSERT INTO router_adjustments (model_key, adjustment_type, delta, reason, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(modelKey, type, delta, reason, expiresAt);
  }

  /**
   * Get all active (non-expired) adjustments for a model.
   */
  getActiveAdjustments(modelKey: string): RouterAdjustment[] {
    const rows = this.db.prepare(`
      SELECT * FROM router_adjustments
      WHERE model_key = ?
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY id DESC
    `).all(modelKey) as Array<{
      id: number; model_key: string; adjustment_type: string;
      delta: number; reason: string; created_at: string; expires_at: string | null;
    }>;
    return rows.map(r => ({
      id: r.id, modelKey: r.model_key,
      adjustmentType: r.adjustment_type as RouterAdjustment['adjustmentType'],
      delta: r.delta, reason: r.reason,
      createdAt: r.created_at, expiresAt: r.expires_at,
    }));
  }

  /**
   * Get the resolved adjustment effects for a model:
   * - sum of score_delta adjustments
   * - sum of weight_boost adjustments
   * - latest temp_override value (if any)
   */
  resolveAdjustments(modelKey: string): ResolvedAdjustment {
    const adj = this.getActiveAdjustments(modelKey);
    const scoreDelta = adj
      .filter(a => a.adjustmentType === 'score_delta')
      .reduce((sum, a) => sum + a.delta, 0);
    const weightBoost = adj
      .filter(a => a.adjustmentType === 'weight_boost')
      .reduce((sum, a) => sum + a.delta, 0);
    const tempOverrides = adj
      .filter(a => a.adjustmentType === 'temp_override')
      .sort((a, b) => (new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime()));
    const latestTemp = tempOverrides[0]?.delta ?? null;
    const primaryType = adj.length > 0 ? adj[0].adjustmentType : null;

    return {
      modelKey,
      adjustmentType: primaryType,
      delta: weightBoost,
      reason: adj.map(a => a.reason).join('; '),
      effectiveScore: scoreDelta,
      temperatureOverride: latestTemp ?? undefined,
      createdAt: adj[0]?.createdAt,
      expiresAt: adj[0]?.expiresAt ?? null,
    };
  }

  // ── Lesson application ─────────────────────────────────────────────────────

  /**
   * Parse a lesson string and apply it as an actual system change.
   *
   * Examples of lessons that get applied:
   * - "GLM-5.0 performs poorly on code tasks below 0.7 temp" → score_delta -1.5 on glm5 for code tasks
   * - "Anthropic Sonnet outperforms GPT-4 on reasoning"       → weight_boost +0.5 on claude-sonnet
   * - "use temperature 0.7 for reasoning tasks"               → temp_override 0.7 for reasoning model
   */
  applyLesson(
    lessonText: string,
    context: { modelKey?: string; taskType?: string; score?: number; temperature?: number }
  ): LessonApplication | null {
    const lower = lessonText.toLowerCase();

    // Pattern: "X performs poorly on Y tasks" or "X underperforms on Y"
    const poorMatch = lessonText.match(/([a-zA-Z0-9_-]+)\s+(?:performs?\s+poorly|underperforms?|struggles?)\s+on\s+(\w+)\s+tasks?/i);
    if (poorMatch) {
      const [, model, task] = poorMatch;
      const delta = -1.5;
      this.writeAdjustment(
        model.toLowerCase().includes('glm') ? 'glm' :
        model.toLowerCase().includes('claude') ? 'claude-sonnet' :
        model.toLowerCase().includes('gpt') ? 'gpt-4o-mini' : model,
        'score_delta', delta,
        `Lesson: ${lessonText}`, null
      );
      return this.recordApplication(lessonText, 'router_adjustment', 'score_delta', { model, task, delta });
    }

    // Pattern: "X outperforms Y on Z tasks" or "X is better than Y for Z"
    const outperformMatch = lessonText.match(/([a-zA-Z0-9_-]+)\s+(?:outperforms?|is\s+better(?:\s+than)?)\s+(?:than\s+)?([a-zA-Z0-9_-]+)\s+(?:on|for)\s+(\w+)\s+tasks?/i);
    if (outperformMatch) {
      const [, winner, _loser, task] = outperformMatch;
      const winnerKey = this._modelNameToKey(winner);
      this.writeAdjustment(winnerKey, 'weight_boost', 0.5,
        `Lesson: ${winner} outperforms on ${task} tasks`, null
      );
      return this.recordApplication(lessonText, 'router_adjustment', 'weight_boost',
        { winner: winnerKey, task, boost: 0.5 }
      );
    }

    // Pattern: "use temperature X for Y tasks"
    const tempMatch = lessonText.match(/temperature\s+(?:of\s+)?([0-9.]+)\s+(?:for|on)\s+(\w+)\s+tasks?/i);
    if (tempMatch) {
      const [, temp, task] = tempMatch;
      const modelKey = task === 'reasoning' ? 'reasoning' : task === 'coding' ? 'coding' : 'balanced';
      this.writeAdjustment(modelKey, 'temp_override', parseFloat(temp),
        `Lesson: use temp ${temp} for ${task} tasks`, null
      );
      return this.recordApplication(lessonText, 'router_adjustment', 'temp_override',
        { task, temperature: parseFloat(temp) }
      );
    }

    // Pattern: "X is strong/weak at/for Y"
    const strongMatch = lessonText.match(/([a-zA-Z0-9_-]+)\s+is\s+(strong|weak)\s+(?:at|for)\s+(\w+)/i);
    if (strongMatch) {
      const [, model, direction, area] = strongMatch;
      const modelKey = this._modelNameToKey(model);
      if (direction === 'strong') {
        this.writeAdjustment(modelKey, 'weight_boost', 0.3,
          `Lesson: ${model} is strong at ${area}`, null
        );
      } else {
        this.writeAdjustment(modelKey, 'score_delta', -0.5,
          `Lesson: ${model} is weak at ${area}`, null
        );
      }
      return this.recordApplication(lessonText, 'router_adjustment',
        direction === 'strong' ? 'weight_boost' : 'score_delta',
        { modelKey, area, direction }
      );
    }

    // Default: no parseable action — still record it
    return null;
  }

  /**
   * Record that a lesson was applied (or that it couldn't be parsed).
   */
  private recordApplication(
    lessonText: string,
    appType: LessonApplication['applicationType'],
    target: string,
    change: Record<string, unknown>
  ): LessonApplication {
    const result = this.db.prepare(`
      INSERT INTO applied_lessons (lesson_text, application_type, target_component, change_made)
      VALUES (?, ?, ?, ?)
    `).run(lessonText, appType, target, JSON.stringify(change));

    return {
      id: result.lastInsertRowid as number,
      lessonText,
      applicationType: appType,
      targetComponent: target,
      changeMade: change,
      effectivenessScore: null,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Mark a previously applied lesson's effectiveness score.
   * Called on the NEXT run after a lesson was applied.
   * Higher score = the lesson's adjustment helped.
   */
  setLessonEffectiveness(lessonId: number, score: number): void {
    this.db.prepare(`UPDATE applied_lessons SET effectiveness_score = ? WHERE id = ?`)
      .run(score, lessonId);
  }

  /**
   * Get the effectiveness history of applied lessons.
   */
  getAppliedLessons(limit = 20): LessonApplication[] {
    const rows = this.db.prepare(
      `SELECT * FROM applied_lessons ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as Array<{
      id: number; lesson_text: string; application_type: string;
      target_component: string; change_made: string;
      effectiveness_score: number | null; created_at: string;
    }>;
    return rows.map(r => ({
      id: r.id, lessonText: r.lesson_text,
      applicationType: r.application_type as LessonApplication['applicationType'],
      targetComponent: r.target_component,
      changeMade: JSON.parse(r.change_made),
      effectivenessScore: r.effectiveness_score,
      createdAt: r.created_at,
    }));
  }

  // ── Convenience: apply all unexpired lessons from a lesson string ───────────

  /**
   * Called by the orchestrator after a run.
   * Parses the lesson text and applies any actionable adjustments.
   * Returns all applied lessons.
   */
  processRunLesson(
    lessonText: string,
    runContext: { modelKey?: string; taskType?: string; score?: number; temperature?: number }
  ): LessonApplication[] {
    const applied: LessonApplication[] = [];
    // Try to parse and apply the lesson
    const result = this.applyLesson(lessonText, runContext);
    if (result) applied.push(result);

    // Also check for score-based auto-adjustments
    if (runContext.score !== undefined && runContext.modelKey) {
      if (runContext.score < 4) {
        // Very poor score — penalize this model
        this.writeAdjustment(
          runContext.modelKey, 'score_delta', -1,
          `Auto: score ${runContext.score} < 4 for ${runContext.taskType ?? 'general'} tasks`,
          null
        );
        const rec = this.recordApplication(
          lessonText, 'router_adjustment', runContext.modelKey,
          { score_delta: -1, reason: 'auto-penalize poor score' }
        );
        applied.push(rec);
      } else if (runContext.score >= 8) {
        // Excellent score — boost this model for this task type
        this.writeAdjustment(
          runContext.modelKey, 'weight_boost', 0.3,
          `Auto: score ${runContext.score} >= 8 for ${runContext.taskType ?? 'general'} tasks`,
          null
        );
        const rec = this.recordApplication(
          lessonText, 'router_adjustment', runContext.modelKey,
          { weight_boost: 0.3, reason: 'auto-boost excellent score' }
        );
        applied.push(rec);
      }
    }

    return applied;
  }

  /**
   * Read back router adjustments for a given task type and return actionable advice
   * for the next iteration. This closes the self-iteration loop: lessons learned are
   * applied to subsequent arm selection.
   */
  getAdvice(taskType: string | undefined): ModelAdvice[] {
    if (!taskType) return [];

    // Find all non-expired adjustments whose reason mentions this task type
    const rows = this.db.prepare(`
      SELECT model_key, adjustment_type, delta, reason, expires_at, created_at
      FROM router_adjustments
      WHERE (expires_at IS NULL OR expires_at > datetime('now'))
        AND reason LIKE ?
      ORDER BY created_at DESC
    `).all(`%${taskType}%`) as Array<{
      model_key: string;
      adjustment_type: string;
      delta: number;
      reason: string;
      expires_at: string | null;
      created_at: string;
    }>;

    if (rows.length === 0) return [];

    // Deduplicate: keep only the most recent adjustment per model+type combo
    const seen = new Set<string>();
    const advice: ModelAdvice[] = [];
    for (const row of rows) {
      const key = `${row.model_key}:${row.adjustment_type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      advice.push({
        modelKey: row.model_key,
        adjustmentType: row.adjustment_type as ModelAdvice['adjustmentType'],
        delta: row.delta,
        reason: row.reason,
      });
    }
    return advice;
  }

  // ── Helper ─────────────────────────────────────────────────────────────────

  private _modelNameToKey(name: string): string {
    const n = name.toLowerCase();
    if (n.includes('claude') || n.includes('sonnet') || n.includes('opus') || n.includes('haiku')) return 'claude-sonnet';
    if (n.includes('gpt') && n.includes('4o-mini')) return 'gpt-4o-mini';
    if (n.includes('gpt') && n.includes('4o')) return 'gpt-4o';
    if (n.includes('glm') || n.includes('zhipu')) return 'glm';
    if (n.includes('minimax')) return 'minimax';
    if (n.includes('ollama')) return 'ollama';
    if (n.includes('gemini')) return 'gemini';
    if (n.includes('groq')) return 'groq';
    return name.toLowerCase().replace(/\s+/g, '-');
  }

  close(): void {
    this.db.close();
  }
}
