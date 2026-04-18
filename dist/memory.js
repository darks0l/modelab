import Database from 'better-sqlite3';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
const DATA_DIR = join(homedir(), '.modelab');
const DB_PATH = join(DATA_DIR, 'memory.db');
function ensureDir() {
    if (!existsSync(DATA_DIR))
        mkdirSync(DATA_DIR, { recursive: true });
}
function openDb() {
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
      what_worked  TEXT  NOT NULL DEFAULT '',
      what_didnt_work TEXT  NOT NULL DEFAULT '',
      lesson       TEXT  NOT NULL DEFAULT '',
      summary_text TEXT  NOT NULL DEFAULT '',
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
    db;
    constructor() {
        this.db = openDb();
    }
    log(result, runId, goalId) {
        const stmt = this.db.prepare(`
      INSERT INTO experiments
        (id, run_id, goal_id, arm_id, score, cost_usd, input_tokens, output_tokens,
         output, model, duration_ms, latency_ms, iteration, timestamp)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(`${armId(result.armId)}-${Date.now()}`, runId, goalId, result.armId, result.score, result.costUsd, result.tokensUsed.input, result.tokensUsed.output, result.output, result.model, result.durationMs, result.latencyMs ?? 0, result.iteration, result.timestamp);
    }
    getHistory(goalId) {
        const sql = goalId
            ? `SELECT * FROM experiments WHERE goal_id = ? ORDER BY timestamp DESC LIMIT 100`
            : `SELECT * FROM experiments ORDER BY timestamp DESC LIMIT 100`;
        const rows = (goalId
            ? this.db.prepare(sql).all(goalId)
            : this.db.prepare(sql).all());
        return rows.map(mapRow);
    }
    getBest(goalId) {
        const row = this.db.prepare(`SELECT * FROM experiments WHERE goal_id = ? AND score IS NOT NULL ORDER BY score DESC LIMIT 1`).get(goalId);
        return row ? mapRow(row) : null;
    }
    getAverageScore(goalId) {
        const row = this.db.prepare(`SELECT AVG(score) as avg FROM experiments WHERE goal_id = ? AND score IS NOT NULL`).get(goalId);
        return row?.avg ?? null;
    }
    getTotalSpend(goalId) {
        const sql = goalId
            ? `SELECT SUM(cost_usd) as total FROM experiments WHERE goal_id = ?`
            : `SELECT SUM(cost_usd) as total FROM experiments`;
        const row = (goalId
            ? this.db.prepare(sql).get(goalId)
            : this.db.prepare(sql).get());
        return row?.total ?? 0;
    }
    /**
     * Summarize what happened in a completed iteration and store it.
     * Call this after each iteration completes (after all arms have run).
     */
    summarize(runId, goalId, iteration, results) {
        const scored = results.filter(r => r.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const best = scored[0] ?? null;
        const worst = scored[scored.length - 1] ?? null;
        // Build what worked / didn't work strings
        const whatWorked = best && best.output
            ? best.output.slice(0, 500)
            : '';
        const whatDidntWork = worst && worst.output && worst.score !== null && worst.score < (best?.score ?? 10)
            ? worst.output.slice(0, 300)
            : '';
        // Build lesson string
        let lesson = '';
        if (best && worst && best.score !== null && worst.score !== null) {
            const diff = best.score - worst.score;
            if (diff > 2) {
                lesson = `${best.armId} outperformed ${worst.armId} by ${diff.toFixed(1)} points — prefer this approach`;
            }
            else if (best.score >= 8) {
                lesson = `${best.armId} achieved high quality (${best.score}/10)`;
            }
            else {
                lesson = `Best score ${best.score}/10 — room for improvement in next iteration`;
            }
        }
        else if (best) {
            lesson = `Best so far: ${best.armId} at ${best.score}/10`;
        }
        // Build full summary
        const summaryLines = [
            `## Iteration ${iteration} Summary`,
            `Best: ${best?.armId ?? 'none'} (${best?.score ?? 'N/A'}/10)`,
            `Arms run: ${results.length}`,
            results.map(r => `  - ${r.armId}: ${r.score !== null ? r.score + '/10' : 'N/A'} | $${r.costUsd.toFixed(4)} | ${r.durationMs}ms`).join('\n'),
            `Lesson: ${lesson}`,
        ].filter(l => l);
        const summaryText = summaryLines.join('\n');
        const id = `sum-${runId}-${iteration}`;
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO iteration_summaries
        (id, run_id, goal_id, iteration, best_score, best_arm_id,
         what_worked, what_didnt_work, lesson, summary_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(id, runId, goalId, iteration, best?.score ?? null, best?.armId ?? null, whatWorked, whatDidntWork, lesson, summaryText, new Date().toISOString());
        return {
            id,
            runId,
            goalId,
            iteration,
            bestScore: best?.score ?? null,
            bestArmId: best?.armId ?? null,
            whatWorked,
            whatDidntWork,
            lesson,
            summaryText,
            createdAt: new Date().toISOString(),
        };
    }
    /**
     * Get all iteration summaries for a goal (across all runs).
     */
    getSummaries(goalId) {
        const rows = this.db.prepare(`SELECT * FROM iteration_summaries WHERE goal_id = ? ORDER BY iteration ASC`).all(goalId);
        return rows.map(mapSummaryRow);
    }
    /**
     * Get the iteration context needed before starting iteration `iter`.
     * This aggregates all prior iterations and formats them as a prompt string
     * that can be injected as {{iteration_context}} into arm prompts.
     */
    getContextForIteration(goalId, runId, iter) {
        const priorSummaries = this.getSummaries(goalId)
            .filter(s => s.runId === runId && s.iteration < iter);
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
                    if (s.lesson)
                        lines.push(`**Lesson:** ${s.lesson}`);
                    if (s.whatWorked)
                        lines.push(`**What worked:** ${s.whatWorked.slice(0, 200)}`);
                    if (s.whatDidntWork)
                        lines.push(`**What didn't work:** ${s.whatDidntWork.slice(0, 200)}`);
                    return lines.join('\n');
                }),
                '',
                `## Guidance for Next Iteration`,
                bestOverall
                    ? `So far the best approach is: ${bestOverall.armId} (${bestOverall.score}/10). Build on what worked and avoid what didn't.`
                    : `No prior iterations with scored results yet.`,
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
    /**
     * Get all "lessons" — the distilled takeaways across all goals/runs.
     * Useful for the `modelab lessons` CLI command.
     */
    getLessons(goalId) {
        const sql = goalId
            ? `SELECT goal_id, run_id, iteration, lesson, best_score FROM iteration_summaries WHERE goal_id = ? AND lesson != '' ORDER BY created_at ASC`
            : `SELECT goal_id, run_id, iteration, lesson, best_score FROM iteration_summaries WHERE lesson != '' ORDER BY created_at ASC`;
        const rows = (goalId ? this.db.prepare(sql).all(goalId) : this.db.prepare(sql).all());
        return rows.map(r => ({
            goalId: r.goal_id,
            runId: r.run_id,
            iteration: r.iteration,
            lesson: r.lesson,
            bestScore: r.best_score,
        }));
    }
    close() {
        this.db.close();
    }
}
function armId(base) {
    return base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
}
function mapSummaryRow(r) {
    return {
        id: r.id,
        runId: r.run_id,
        goalId: r.goal_id,
        iteration: r.iteration,
        bestScore: r.best_score,
        bestArmId: r.best_arm_id,
        whatWorked: r.what_worked,
        whatDidntWork: r.what_didnt_work,
        lesson: r.lesson,
        summaryText: r.summary_text,
        createdAt: r.created_at,
    };
}
function mapRow(r) {
    return {
        armId: r.arm_id,
        model: r.model,
        output: r.output,
        score: r.score ?? null,
        costUsd: r.cost_usd,
        tokensUsed: { input: r.input_tokens, output: r.output_tokens },
        durationMs: r.duration_ms,
        latencyMs: r.latency_ms ?? 0,
        timestamp: r.timestamp,
        iteration: r.iteration,
        runId: r.run_id,
        goalId: r.goal_id,
    };
}
//# sourceMappingURL=memory.js.map