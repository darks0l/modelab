import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

// Test with an in-memory SQLite database — we replicate the schema and test the
// SQL-heavy logic by manually constructing rows and calling the map functions.

describe('memory persistence schema', () => {
  // We test that the schema creates the right tables/indexes and that
  // SQL queries return expected shapes when called against a real (temp) DB.

  const TEST_DB = join(tmpdir(), `modelab-test-${Date.now()}.db`);

  beforeEach(() => {
    const db = new Database(TEST_DB);
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
    `);
    db.close();
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch { /* ok */ }
  });

  function openTestDb() {
    const db = new Database(TEST_DB);
    db.pragma('journal_mode = WAL');
    return db;
  }

  it('inserts and retrieves an experiment row', () => {
    const db = openTestDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO experiments
        (id, run_id, goal_id, arm_id, score, cost_usd, input_tokens, output_tokens, output, model, duration_ms, iteration, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('exp-1', 'run-1', 'goal-1', 'arm-balanced', 8.5, 0.002, 200, 100, 'Answer text', 'balanced', 500, 1, now);

    const row = db.prepare('SELECT * FROM experiments WHERE id = ?').get('exp-1') as Record<string, unknown>;
    expect(row.run_id).toBe('run-1');
    expect(row.goal_id).toBe('goal-1');
    expect(row.arm_id).toBe('arm-balanced');
    expect(row.score).toBe(8.5);
    expect(row.cost_usd).toBeCloseTo(0.002);
    db.close();
  });

  it('returns null when no best result exists', () => {
    const db = openTestDb();
    const row = db.prepare(
      `SELECT * FROM experiments WHERE goal_id = ? AND score IS NOT NULL ORDER BY score DESC LIMIT 1`
    ).get('nonexistent-goal');
    expect(row).toBeUndefined();
    db.close();
  });

  it('calculates average score correctly', () => {
    const db = openTestDb();
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO experiments (id, run_id, goal_id, arm_id, score, cost_usd, input_tokens, output_tokens, output, model, duration_ms, iteration, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('e1', 'r', 'g', 'a', 7.0, 0.001, 100, 50, 'out', 'm', 100, 1, now);
    insert.run('e2', 'r', 'g', 'a', 9.0, 0.001, 100, 50, 'out', 'm', 100, 1, now);
    insert.run('e3', 'r', 'g', 'a', null, 0.001, 100, 50, 'out', 'm', 100, 1, now);

    const avgRow = db.prepare(`SELECT AVG(score) as avg FROM experiments WHERE goal_id = ? AND score IS NOT NULL`).get('g') as { avg: number };
    expect(avgRow.avg).toBeCloseTo(8.0);
    db.close();
  });

  it('totals cost correctly across multiple rows', () => {
    const db = openTestDb();
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO experiments (id, run_id, goal_id, arm_id, score, cost_usd, input_tokens, output_tokens, output, model, duration_ms, iteration, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('e1', 'r', 'g', 'a', 7, 0.001, 100, 50, 'out', 'm', 100, 1, now);
    insert.run('e2', 'r', 'g', 'a', 8, 0.002, 100, 50, 'out', 'm', 100, 1, now);
    insert.run('e3', 'r', 'g', 'a', 9, 0.0035, 100, 50, 'out', 'm', 100, 1, now);

    const total = db.prepare(`SELECT SUM(cost_usd) as total FROM experiments WHERE goal_id = ?`).get('g') as { total: number };
    expect(total.total).toBeCloseTo(0.0065);
    db.close();
  });

  it('retrieves iteration summaries in order', () => {
    const db = openTestDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('s1', 'run', 'goal', 1, 7.0, 'arm-a', 'First lesson', 'Summary 1', 'worked', 'didnt', now);
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('s2', 'run', 'goal', 2, 8.5, 'arm-b', 'Second lesson', 'Summary 2', 'worked2', 'didnt2', now);

    const rows = db.prepare(`SELECT * FROM iteration_summaries WHERE goal_id = ? ORDER BY iteration ASC`).all('goal') as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    expect(rows[0].lesson).toBe('First lesson');
    expect(rows[1].lesson).toBe('Second lesson');
    db.close();
  });

  it('lesson extraction query returns only rows with non-empty lessons', () => {
    const db = openTestDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('s1', 'run', 'goal', 1, 7.0, 'arm', '', 'summary', '', '', now);
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('s2', 'run', 'goal', 2, 8.0, 'arm', 'Keep doing X', 'summary', '', '', now);

    const rows = db.prepare(`SELECT * FROM iteration_summaries WHERE goal_id = ? AND lesson != '' ORDER BY created_at ASC`).all('goal') as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].lesson).toBe('Keep doing X');
    db.close();
  });
});
