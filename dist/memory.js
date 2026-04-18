import Database from 'better-sqlite3';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
const DATA_DIR = join(homedir(), '.modelab');
const DB_PATH = join(DATA_DIR, 'memory.db');
function ensureDir() {
    if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
    }
}
function openDb() {
    ensureDir();
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id          TEXT  NOT NULL,
      run_id      TEXT  NOT NULL,
      goal_id     TEXT  NOT NULL,
      arm_id      TEXT  NOT NULL,
      score       REAL,
      cost_usd    REAL  NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      output      TEXT  NOT NULL,
      model       TEXT  NOT NULL,
      duration_ms INTEGER NOT NULL,
      iteration   INTEGER NOT NULL,
      timestamp   TEXT  NOT NULL,
      notes       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_goal_id   ON experiments(goal_id);
    CREATE INDEX IF NOT EXISTS idx_run_id    ON experiments(run_id);
    CREATE INDEX IF NOT EXISTS idx_arm_id    ON experiments(arm_id);
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
         output, model, duration_ms, iteration, timestamp, notes)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(`${armId(result.armId)}-${Date.now()}`, runId, goalId, result.armId, result.score, result.costUsd, result.tokensUsed.input, result.tokensUsed.output, result.output, result.armId.split(':')[0], // model key embedded in arm id
        result.durationMs, result.iteration, result.timestamp, result.notes ?? null);
    }
    getHistory(goalId) {
        const sql = goalId
            ? `SELECT * FROM experiments WHERE goal_id = ? ORDER BY timestamp DESC LIMIT 100`
            : `SELECT * FROM experiments ORDER BY timestamp DESC LIMIT 100`;
        const rows = goalId
            ? this.db.prepare(sql).all(goalId)
            : this.db.prepare(sql).all();
        return rows.map(mapRow);
    }
    getBest(goalId) {
        const row = this.db.prepare(`SELECT * FROM experiments WHERE goal_id = ? AND score IS NOT NULL
       ORDER BY score DESC LIMIT 1`).get(goalId);
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
        const row = goalId
            ? this.db.prepare(sql).get(goalId)
            : this.db.prepare(sql).get();
        return row?.total ?? 0;
    }
    close() {
        this.db.close();
    }
}
// Small helper to name unique IDs
function armId(base) {
    return base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
}
function mapRow(r) {
    return {
        armId: r.arm_id,
        output: r.output,
        score: r.score ?? null,
        costUsd: r.cost_usd,
        tokensUsed: { input: r.input_tokens, output: r.output_tokens },
        durationMs: r.duration_ms,
        timestamp: r.timestamp,
        notes: r.notes ?? undefined,
        iteration: r.iteration,
    };
}
//# sourceMappingURL=memory.js.map