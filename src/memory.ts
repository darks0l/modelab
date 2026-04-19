import Database from 'better-sqlite3';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { ExperimentResult } from './types.js';

export interface IterationSummary {
  id: string;
  runId: string;
  goalId: string;
  iteration: number;
  /** Best score achieved this iteration */
  bestScore: number | null;
  /** Which arm achieved the best score */
  bestArmId: string | null;
  /** Best TTFT latency (ms) this iteration */
  bestLatencyMs: number | null;
  /** What worked — concatenated snippets from winning outputs */
  whatWorked: string;
  /** What didn't work */
  whatDidntWork: string;
  /** Key takeaway one-liner */
  lesson: string;
  /** Full raw summary text */
  summaryText: string;
  createdAt: string;
}

export interface RunLatencyStats {
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  sampleCount: number;
  /** Best (lowest) TTFT latency across all arms */
  bestMs: number | null;
  /** Which arm had the best latency */
  bestArmId: string | null;
}

export interface RunSummary {
  runId: string;
  goalId: string;
  status: string;
  totalCostUsd: number;
  totalArms: number;
  totalIterations: number;
  bestScore: number | null;
  bestArmId: string | null;
  bestIteration: number | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /** Per-iteration summaries for this run */
  iterationSummaries: IterationSummary[];
  /** Key experiment-level lesson */
  lesson: string;
  /** Full run report text */
  report: string;
  /** TTFT latency statistics across all arms */
  latencyStats: RunLatencyStats;
  /** Average TTFT latency (ms) across all arms */
  avgLatencyMs: number;
}

export interface IterationContext {
  iteration: number;
  priorIterations: IterationSummary[];
  bestScoreSoFar: number | null;
  bestArmSoFar: string | null;
  /** Markdown-formatted context string for injection into prompts */
  contextString: string;
}

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
    CREATE TABLE IF NOT EXISTS experiments (
      id           TEXT  NOT NULL,
      run_id       TEXT  NOT NULL,
      goal_id      TEXT  NOT NULL,
      arm_id       TEXT  NOT NULL,
      score        REAL,
      cost_usd     REAL  NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      output       TEXT  NOT NULL,
      model        TEXT  NOT NULL,
      duration_ms  INTEGER NOT NULL,
      latency_ms   INTEGER NOT NULL DEFAULT 0,
      iteration    INTEGER NOT NULL,
      timestamp    TEXT  NOT NULL
    );
    CREATE TABLE IF NOT EXISTS iteration_summaries (
      id           TEXT  NOT NULL PRIMARY KEY,
      run_id       TEXT  NOT NULL,
      goal_id      TEXT  NOT NULL,
      iteration    INTEGER NOT NULL,
      best_score   REAL,
      best_arm_id  TEXT,
      best_latency_ms INTEGER,
      what_worked  TEXT  NOT NULL DEFAULT '',
      what_didnt_work TEXT  NOT NULL DEFAULT '',
      lesson       TEXT  NOT NULL DEFAULT '',
      summary_text TEXT  NOT NULL DEFAULT '',
      created_at   TEXT  NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_summaries (
      run_id       TEXT  NOT NULL PRIMARY KEY,
      goal_id      TEXT  NOT NULL,
      status       TEXT  NOT NULL,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      total_arms   INTEGER NOT NULL DEFAULT 0,
      total_iterations INTEGER NOT NULL DEFAULT 0,
      best_score   REAL,
      best_arm_id  TEXT,
      best_iteration INTEGER,
      best_latency_ms INTEGER,
      avg_latency_ms INTEGER NOT NULL DEFAULT 0,
      started_at   TEXT  NOT NULL,
      completed_at TEXT  NOT NULL,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      lesson       TEXT  NOT NULL DEFAULT '',
      report       TEXT  NOT NULL DEFAULT '',
      created_at   TEXT  NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goal_id ON experiments(goal_id);
    CREATE INDEX IF NOT EXISTS idx_run_id  ON experiments(run_id);
    CREATE INDEX IF NOT EXISTS idx_arm_id  ON experiments(arm_id);
    CREATE INDEX IF NOT EXISTS idx_summary_goal ON iteration_summaries(goal_id);
    CREATE INDEX IF NOT EXISTS idx_summary_run  ON iteration_summaries(run_id);
  `);
  return db;
}

export class ExperimentMemory {
  /** @internal */
  db: Database.Database;

  constructor();
  /** @internal - test-only constructor that opens a custom DB path */
  constructor(dbPath: string);
  constructor(dbPath?: string) {
    this.db = dbPath ? new Database(dbPath) : openDb();
    if (dbPath) {
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS experiments (
          id           TEXT  NOT NULL,
          run_id       TEXT  NOT NULL,
          goal_id      TEXT  NOT NULL,
          arm_id       TEXT  NOT NULL,
          score        REAL,
          cost_usd     REAL  NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          output       TEXT  NOT NULL,
          model        TEXT  NOT NULL,
          duration_ms  INTEGER NOT NULL,
          latency_ms   INTEGER NOT NULL DEFAULT 0,
          iteration    INTEGER NOT NULL,
          timestamp    TEXT  NOT NULL
        );
        CREATE TABLE IF NOT EXISTS iteration_summaries (
          id           TEXT  NOT NULL PRIMARY KEY,
          run_id       TEXT  NOT NULL,
          goal_id      TEXT  NOT NULL,
          iteration    INTEGER NOT NULL,
          best_score   REAL,
          best_arm_id  TEXT,
          best_latency_ms INTEGER,
          what_worked  TEXT  NOT NULL DEFAULT '',
          what_didnt_work TEXT  NOT NULL DEFAULT '',
          lesson       TEXT  NOT NULL DEFAULT '',
          summary_text TEXT  NOT NULL DEFAULT '',
          created_at   TEXT  NOT NULL
        );
        CREATE TABLE IF NOT EXISTS run_summaries (
          run_id       TEXT  NOT NULL PRIMARY KEY,
          goal_id      TEXT  NOT NULL,
          status       TEXT  NOT NULL,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          total_arms   INTEGER NOT NULL DEFAULT 0,
          total_iterations INTEGER NOT NULL DEFAULT 0,
          best_score   REAL,
          best_arm_id  TEXT,
          best_iteration INTEGER,
          best_latency_ms INTEGER,
          avg_latency_ms INTEGER NOT NULL DEFAULT 0,
          started_at   TEXT  NOT NULL,
          completed_at TEXT  NOT NULL,
          duration_ms  INTEGER NOT NULL DEFAULT 0,
          lesson       TEXT  NOT NULL DEFAULT '',
          report       TEXT  NOT NULL DEFAULT '',
          created_at   TEXT  NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_goal_id ON experiments(goal_id);
        CREATE INDEX IF NOT EXISTS idx_run_id  ON experiments(run_id);
        CREATE INDEX IF NOT EXISTS idx_arm_id  ON experiments(arm_id);
        CREATE INDEX IF NOT EXISTS idx_summary_goal ON iteration_summaries(goal_id);
        CREATE INDEX IF NOT EXISTS idx_summary_run  ON iteration_summaries(run_id);
      `);
    }
  }

  /**
   * Test-only constructor — opens a database at the given path instead of ~/.modelab/memory.db.
   * Used exclusively by the test suite to test against isolated temp databases.
   * @internal
   */
  log(result: ExperimentResult, runId: string, goalId: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO experiments
        (id, run_id, goal_id, arm_id, score, cost_usd, input_tokens, output_tokens,
         output, model, duration_ms, latency_ms, iteration, timestamp)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      `${armId(result.armId)}-${Date.now()}`,
      runId, goalId,
      result.armId, result.score, result.costUsd,
      result.tokensUsed.input, result.tokensUsed.output,
      result.output, result.model,
      result.durationMs, result.latencyMs ?? 0, result.iteration, result.timestamp
    );
  }

  getHistory(goalId?: string): ExperimentResult[] {
    const sql = goalId
      ? `SELECT * FROM experiments WHERE goal_id = ? ORDER BY timestamp DESC LIMIT 100`
      : `SELECT * FROM experiments ORDER BY timestamp DESC LIMIT 100`;
    const rows = (goalId
      ? this.db.prepare(sql).all(goalId)
      : this.db.prepare(sql).all()) as DbRow[];
    return rows.map(mapRow);
  }

  getBest(goalId: string): ExperimentResult | null {
    const row = this.db.prepare(
      `SELECT * FROM experiments WHERE goal_id = ? AND score IS NOT NULL ORDER BY score DESC LIMIT 1`
    ).get(goalId) as DbRow | undefined;
    return row ? mapRow(row) : null;
  }

  getAverageScore(goalId: string): number | null {
    const row = this.db.prepare(
      `SELECT AVG(score) as avg FROM experiments WHERE goal_id = ? AND score IS NOT NULL`
    ).get(goalId) as { avg: number | null } | undefined;
    return row?.avg ?? null;
  }

  getTotalSpend(goalId?: string): number {
    const sql = goalId
      ? `SELECT SUM(cost_usd) as total FROM experiments WHERE goal_id = ?`
      : `SELECT SUM(cost_usd) as total FROM experiments`;
    const row = (goalId
      ? this.db.prepare(sql).get(goalId)
      : this.db.prepare(sql).get()) as { total: number | null } | undefined;
    return row?.total ?? 0;
  }

  summarize(
    runId: string,
    goalId: string,
    iteration: number,
    results: ExperimentResult[]
  ): IterationSummary {
    const scored = results.filter(r => r.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const best = scored[0] ?? null;
    const worst = scored[scored.length - 1] ?? null;

    const whatWorked = best && best.output
      ? best.output.slice(0, 500)
      : '';

    const whatDidntWork = worst && worst.output && worst.score !== null && worst.score < (best?.score ?? 10)
      ? worst.output.slice(0, 300)
      : '';

    let lesson = '';
    if (best && worst && best.score !== null && worst.score !== null) {
      const diff = best.score - worst.score;
      if (diff > 2) {
        lesson = `${best.armId} outperformed ${worst.armId} by ${diff.toFixed(1)} points — prefer this approach`;
      } else if (best.score >= 8) {
        lesson = `${best.armId} achieved high quality (${best.score}/10)`;
      } else {
        lesson = `Best score ${best.score}/10 — room for improvement in next iteration`;
      }
    } else if (best) {
      lesson = `Best so far: ${best.armId} at ${best.score}/10`;
    }

    const summaryLines = [
      `## Iteration ${iteration} Summary`,
      `Best: ${best?.armId ?? 'none'} (${best?.score ?? 'N/A'}/10)`,
      `Arms run: ${results.length}`,
      results.map(r => `  - ${r.armId}: ${r.score !== null ? r.score + '/10' : 'N/A'} | $${r.costUsd.toFixed(4)} | ${r.durationMs}ms`).join('\n'),
      `Lesson: ${lesson}`,
    ].filter(l => l);

    const summaryText = summaryLines.join('\n');
    const id = `sum-${runId}-${iteration}`;

    // Best latency: fastest arm among scored results (or all if none scored)
    const allArms = scored.length > 0 ? scored : results;
    const bestLatencyArm = allArms
      .filter(r => r.latencyMs > 0)
      .sort((a, b) => a.latencyMs - b.latencyMs)[0] ?? null;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO iteration_summaries
        (id, run_id, goal_id, iteration, best_score, best_arm_id, best_latency_ms,
         what_worked, what_didnt_work, lesson, summary_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id, runId, goalId, iteration,
      best?.score ?? null, best?.armId ?? null,
      bestLatencyArm?.latencyMs ?? null,
      whatWorked, whatDidntWork, lesson, summaryText,
      new Date().toISOString()
    );

    return {
      id, runId, goalId, iteration,
      bestScore: best?.score ?? null,
      bestArmId: best?.armId ?? null,
      bestLatencyMs: bestLatencyArm?.latencyMs ?? null,
      whatWorked, whatDidntWork, lesson, summaryText,
      createdAt: new Date().toISOString(),
    };
  }

  getSummaries(goalId: string, runId?: string): IterationSummary[] {
    const sql = runId
      ? `SELECT * FROM iteration_summaries WHERE goal_id = ? AND run_id = ? ORDER BY iteration ASC`
      : `SELECT * FROM iteration_summaries WHERE goal_id = ? ORDER BY iteration ASC`;
    const rows = (runId
      ? this.db.prepare(sql).all(goalId, runId)
      : this.db.prepare(sql).all(goalId)) as SummaryRow[];
    return rows.map(mapSummaryRow);
  }

  getContextForIteration(goalId: string, runId: string, iter: number): IterationContext {
    const priorSummaries = this.getSummaries(goalId, runId)
      .filter(s => s.iteration < iter);
    const allPrior = this.getHistory(goalId)
      .filter(r => r.runId === runId && r.iteration < iter);
    const bestOverall = allPrior
      .filter(r => r.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;

    let contextString = '';
    if (priorSummaries.length > 0) {
      contextString = [
        `## Prior Iteration Results (${priorSummaries.length} prior iteration${priorSummaries.length !== 1 ? 's' : ''})`,
        ...priorSummaries.map(s => {
          const lines = [`### Iteration ${s.iteration} — ${s.bestArmId ?? '?'} scored ${s.bestScore ?? 'N/A'}/10`];
          if (s.lesson) lines.push(`**Lesson:** ${s.lesson}`);
          if (s.whatWorked) lines.push(`**What worked:** ${s.whatWorked.slice(0, 200)}`);
          if (s.whatDidntWork) lines.push(`**What didn't work:** ${s.whatDidntWork.slice(0, 200)}`);
          return lines.join('\n');
        }),
        '',
        '## Guidance for Next Iteration',
        bestOverall
          ? `So far the best approach is: ${bestOverall.armId} (${bestOverall.score}/10). Build on what worked and avoid what didn't.`
          : 'No prior iterations with scored results yet.',
      ].join('\n');
    }

    return {
      iteration: iter,
      priorIterations: priorSummaries,
      bestScoreSoFar: bestOverall?.score ?? null,
      bestArmSoFar: bestOverall?.armId ?? null,
      contextString,
    };
  }

  getLessons(goalId?: string): { goalId: string; runId: string; iteration: number; lesson: string; bestScore: number | null }[] {
    const sql = goalId
      ? `SELECT goal_id, run_id, iteration, lesson, best_score FROM iteration_summaries WHERE goal_id = ? AND lesson != '' ORDER BY created_at ASC`
      : `SELECT goal_id, run_id, iteration, lesson, best_score FROM iteration_summaries WHERE lesson != '' ORDER BY created_at ASC`;
    const rows = (goalId ? this.db.prepare(sql).all(goalId) : this.db.prepare(sql).all()) as {
      goal_id: string; run_id: string; iteration: number; lesson: string; best_score: number | null;
    }[];
    return rows.map(r => ({
      goalId: r.goal_id,
      runId: r.run_id,
      iteration: r.iteration,
      lesson: r.lesson,
      bestScore: r.best_score,
    }));
  }

  summarizeRun(runId: string, goalId: string, status: string, startedAt: string, completedAt: string, allResults: ExperimentResult[]): RunSummary {
    const iterationSummaries = this.getSummaries(goalId, runId)
      .filter(s => s.runId === runId)
      .sort((a, b) => a.iteration - b.iteration);
    const totalCostUsd = allResults.reduce((s, r) => s + r.costUsd, 0);
    const totalArms = allResults.length;
    const totalIterations = iterationSummaries.length;
    const durationMs = allResults.reduce((max, r) => Math.max(max, r.durationMs), 0);
    const scored = allResults.filter(r => r.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const bestResult = scored[0] ?? null;

    let lesson = '';
    if (iterationSummaries.length >= 2) {
      const improvements = iterationSummaries.filter(s => {
        const prev = iterationSummaries[s.iteration - 2];
        return prev && s.bestScore !== null && prev.bestScore !== null && s.bestScore > prev.bestScore;
      });
      if (improvements.length > 0) {
        const lastImproved = improvements[improvements.length - 1];
        lesson = `Score improved over ${improvements.length} iteration(s) — last improvement at iteration ${lastImproved.iteration} (${lastImproved.bestScore}/10)`;
      } else if (bestResult && bestResult.score !== null && bestResult.score >= 8) {
        lesson = `Achieved quality threshold with best score ${bestResult.score}/10 from ${bestResult.armId}`;
      } else {
        lesson = `Ran ${totalIterations} iterations, best score ${bestResult?.score ?? 'N/A'}/10 — consider adjusting prompts or models`;
      }
    } else if (iterationSummaries.length === 1) {
      const s = iterationSummaries[0];
      lesson = s.lesson || `Single iteration run — best ${s.bestArmId ?? '?'} scored ${s.bestScore ?? 'N/A'}/10`;
    } else {
      lesson = 'No scored results in this run';
    }

    const latencyStats = calcLatencyStats(allResults);
    const avgLatencyMs = latencyStats.avgMs;

    const reportLines = [
      '# Research Run Report',
      `**Run ID:** ${runId}`,
      `**Goal:** ${goalId}`,
      `**Status:** ${status}`,
      `**Started:** ${startedAt}`,
      `**Completed:** ${completedAt}`,
      `**Duration:** ${(durationMs / 1000).toFixed(1)}s`,
      `**Total Cost:** $${totalCostUsd.toFixed(4)}`,
      `**Arms run:** ${totalArms}`,
      `**Iterations:** ${totalIterations}`,
      bestResult ? `**Best result:** ${bestResult.armId} (${bestResult.score ?? 'N/A'}/10)` : null,
      latencyStats.sampleCount > 0
        ? `**TTFT latency:** avg ${latencyStats.avgMs}ms · p50 ${latencyStats.p50Ms}ms · p95 ${latencyStats.p95Ms}ms (n=${latencyStats.sampleCount})`
        : null,
      '',
      '## Experiment Lesson',
      lesson,
      '',
      '## Per-Iteration Summaries',
      ...iterationSummaries.map(s => [
        `### Iteration ${s.iteration} — ${s.bestArmId ?? '?'} scored ${s.bestScore ?? 'N/A'}/10`,
        `**Lesson:** ${s.lesson}`,
        s.whatWorked ? `**What worked:** ${s.whatWorked.slice(0, 300)}` : '',
        s.whatDidntWork ? `**What didn't work:** ${s.whatDidntWork.slice(0, 200)}` : '',
      ].filter(Boolean).join('\n')),
    ].filter(Boolean);

    const report = reportLines.join('\n');

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO run_summaries
        (run_id, goal_id, status, total_cost_usd, total_arms, total_iterations,
         best_score, best_arm_id, best_iteration, best_latency_ms, avg_latency_ms,
         started_at, completed_at, duration_ms,
         lesson, report, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      runId, goalId, status, totalCostUsd, totalArms, totalIterations,
      bestResult?.score ?? null, bestResult?.armId ?? null,
      bestResult ? (allResults.indexOf(bestResult) + 1) : null,
      latencyStats.bestMs ?? null,
      avgLatencyMs,
      startedAt, completedAt, durationMs,
      lesson, report,
      new Date().toISOString()
    );

    return {
      runId, goalId, status, totalCostUsd, totalArms, totalIterations,
      bestScore: bestResult?.score ?? null,
      bestArmId: bestResult?.armId ?? null,
      bestIteration: bestResult ? (allResults.indexOf(bestResult) + 1) : null,
      startedAt, completedAt, durationMs,
      iterationSummaries, lesson, report, latencyStats, avgLatencyMs,
    };
  }

  getRunSummaries(goalId?: string): RunSummary[] {
    const sql = goalId
      ? `SELECT * FROM run_summaries WHERE goal_id = ? ORDER BY created_at DESC`
      : `SELECT * FROM run_summaries ORDER BY created_at DESC`;
    const rows = (goalId
      ? this.db.prepare(sql).all(goalId)
      : this.db.prepare(sql).all()) as RunSummaryRow[];
    return rows.map(r => {
      const iterSummaries = this.getSummaries(r.goal_id, r.run_id);
      const latencyStats = this._latencyStatsForRun(r.run_id);
      return {
        runId: r.run_id, goalId: r.goal_id, status: r.status,
        totalCostUsd: r.total_cost_usd, totalArms: r.total_arms,
        totalIterations: r.total_iterations,
        bestScore: r.best_score, bestArmId: r.best_arm_id, bestIteration: r.best_iteration,
        startedAt: r.started_at, completedAt: r.completed_at, durationMs: r.duration_ms,
        iterationSummaries: iterSummaries.sort((a, b) => a.iteration - b.iteration),
        lesson: r.lesson, report: r.report, latencyStats,
        avgLatencyMs: r.avg_latency_ms,
      };
    });
  }

  getRun(runId: string): RunSummary | null {
    const rows = this.db.prepare(`SELECT * FROM run_summaries WHERE run_id = ?`).all(runId) as RunSummaryRow[];
    if (rows.length === 0) return null;
    const r = rows[0];
    const iterSummaries = this.getSummaries(r.goal_id, r.run_id);
    const latencyStats = this._latencyStatsForRun(runId);
    return {
      runId: r.run_id, goalId: r.goal_id, status: r.status,
      totalCostUsd: r.total_cost_usd, totalArms: r.total_arms,
      totalIterations: r.total_iterations,
      bestScore: r.best_score, bestArmId: r.best_arm_id, bestIteration: r.best_iteration,
      startedAt: r.started_at, completedAt: r.completed_at, durationMs: r.duration_ms,
      iterationSummaries: iterSummaries.sort((a, b) => a.iteration - b.iteration),
      lesson: r.lesson, report: r.report, latencyStats,
      avgLatencyMs: r.avg_latency_ms,
    };
  }

  private _latencyStatsForRun(runId: string): RunLatencyStats {
    const rows = this.db.prepare(
      `SELECT latency_ms FROM experiments WHERE run_id = ? AND latency_ms > 0`
    ).all(runId) as { latency_ms: number }[];
    const latencies = rows.map(r => r.latency_ms);
    if (latencies.length === 0) {
      return { avgMs: 0, p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0, sampleCount: 0, bestMs: null, bestArmId: null };
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const n = sorted.length;
    return {
      avgMs: Math.round(latencies.reduce((s, v) => s + v, 0) / n),
      p50Ms: sorted[Math.floor(n * 0.50)],
      p95Ms: sorted[Math.floor(n * 0.95)],
      minMs: sorted[0],
      maxMs: sorted[n - 1],
      sampleCount: n,
      bestMs: null,
      bestArmId: null,
    };
  }

  close(): void {
    this.db.close();
  }
}

function calcLatencyStats(results: ExperimentResult[]): RunLatencyStats {
  const latencies = results.map(r => r.latencyMs).filter(ms => ms > 0);
  if (latencies.length === 0) {
    return { avgMs: 0, p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0, sampleCount: 0, bestMs: null, bestArmId: null };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  const avgMs = Math.round(latencies.reduce((s, v) => s + v, 0) / n);
  const p50Ms = sorted[Math.floor(n * 0.50)];
  const p95Ms = sorted[Math.floor(n * 0.95)];
  const bestResult = results
    .filter(r => r.latencyMs > 0)
    .sort((a, b) => a.latencyMs - b.latencyMs)[0] ?? null;
  return {
    avgMs, p50Ms, p95Ms, minMs: sorted[0], maxMs: sorted[n - 1], sampleCount: n,
    bestMs: bestResult?.latencyMs ?? null,
    bestArmId: bestResult?.armId ?? null,
  };
}

function armId(base: string): string {
  return base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
}

interface RunSummaryRow {
  run_id: string; goal_id: string; status: string; total_cost_usd: number;
  total_arms: number; total_iterations: number; best_score: number | null;
  best_arm_id: string | null; best_iteration: number | null;
  best_latency_ms: number | null; avg_latency_ms: number;
  started_at: string; completed_at: string; duration_ms: number;
  lesson: string; report: string; created_at: string;
}

interface SummaryRow {
  id: string; run_id: string; goal_id: string; iteration: number;
  best_score: number | null; best_arm_id: string | null; best_latency_ms: number | null;
  what_worked: string; what_didnt_work: string; lesson: string; summary_text: string; created_at: string;
}

function mapSummaryRow(r: SummaryRow): IterationSummary {
  return {
    id: r.id, runId: r.run_id, goalId: r.goal_id, iteration: r.iteration,
    bestScore: r.best_score, bestArmId: r.best_arm_id,
    bestLatencyMs: r.best_latency_ms ?? null,
    whatWorked: r.what_worked, whatDidntWork: r.what_didnt_work,
    lesson: r.lesson, summaryText: r.summary_text, createdAt: r.created_at,
  };
}

interface DbRow {
  id: string; run_id: string; goal_id: string; arm_id: string; model: string;
  score: number | null; cost_usd: number; input_tokens: number; output_tokens: number;
  output: string; duration_ms: number; latency_ms: number; iteration: number; timestamp: string;
}

function mapRow(r: DbRow): ExperimentResult {
  return {
    armId: r.arm_id, model: r.model, output: r.output,
    score: r.score ?? null, costUsd: r.cost_usd,
    tokensUsed: { input: r.input_tokens, output: r.output_tokens },
    durationMs: r.duration_ms, latencyMs: r.latency_ms ?? 0,
    timestamp: r.timestamp, iteration: r.iteration,
    runId: r.run_id, goalId: r.goal_id,
  };
}
