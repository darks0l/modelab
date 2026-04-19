import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { ExperimentMemory } from '../src/memory.js';
import type { ExperimentResult } from '../src/types.js';

// ── Shared test DB setup ─────────────────────────────────────────────────────
// All tests in this file share the same temp DB path but run in isolation
// because ExperimentMemory.__TEST__ creates the full schema (including
// best_latency_ms / best_iteration columns) on top of whatever exists.

const TEST_DB = join(tmpdir(), `modelab-test-${Date.now()}.db`);

function openTestDb() {
  const db = new Database(TEST_DB);
  db.pragma('journal_mode = WAL');
  return db;
}

// Always create the FULL schema (matches ExperimentMemory.__TEST__ logic)
function setupSchema(db: Database.Database) {
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
}

afterEach(() => {
  try { unlinkSync(TEST_DB); } catch { /* ok */ }
});

// ── SQL schema / query tests ─────────────────────────────────────────────────

describe('memory persistence schema', () => {
  beforeEach(() => {
    // Start fresh for each test
    try { unlinkSync(TEST_DB); } catch { /* ok */ }
    const db = openTestDb();
    setupSchema(db);
    db.close();
  });

  it('inserts and retrieves an experiment row', () => {
    const db = openTestDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO experiments
        (id, run_id, goal_id, arm_id, score, cost_usd, input_tokens, output_tokens, output, model, duration_ms, latency_ms, iteration, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('exp-1', 'run-1', 'goal-1', 'arm-balanced', 8.5, 0.002, 200, 100, 'Answer text', 'balanced', 500, 0, 1, now);

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
    const insert = db.prepare(`INSERT INTO experiments (id, run_id, goal_id, arm_id, score, cost_usd, input_tokens, output_tokens, output, model, duration_ms, latency_ms, iteration, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('e1', 'r', 'g', 'a', 7.0, 0.001, 100, 50, 'out', 'm', 100, 0, 1, now);
    insert.run('e2', 'r', 'g', 'a', 9.0, 0.001, 100, 50, 'out', 'm', 100, 0, 1, now);
    insert.run('e3', 'r', 'g', 'a', null, 0.001, 100, 50, 'out', 'm', 100, 0, 1, now);

    const avgRow = db.prepare(`SELECT AVG(score) as avg FROM experiments WHERE goal_id = ? AND score IS NOT NULL`).get('g') as { avg: number };
    expect(avgRow.avg).toBeCloseTo(8.0);
    db.close();
  });

  it('totals cost correctly across multiple rows', () => {
    const db = openTestDb();
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO experiments (id, run_id, goal_id, arm_id, score, cost_usd, input_tokens, output_tokens, output, model, duration_ms, latency_ms, iteration, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('e1', 'r', 'g', 'a', 7, 0.001, 100, 50, 'out', 'm', 100, 0, 1, now);
    insert.run('e2', 'r', 'g', 'a', 8, 0.002, 100, 50, 'out', 'm', 100, 0, 1, now);
    insert.run('e3', 'r', 'g', 'a', 9, 0.0035, 100, 50, 'out', 'm', 100, 0, 1, now);

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

// ── getSummaries runId filtering ───────────────────────────────────────────────
// Tests the correctness fix: getSummaries(goalId, runId) should only return
// summaries for the specified run, not all runs under a goal.

describe('ExperimentMemory getSummaries filtering', () => {
  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch { /* ok */ }
    const db = openTestDb();
    setupSchema(db);
    // Populate: goal "same-goal" has summaries from TWO different runs
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sum-run-A-1', 'run-A', 'same-goal', 1, 7.0, 'arm-A1', 'Lesson from run A iter 1', 'Summary A1', '', '', now);
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sum-run-A-2', 'run-A', 'same-goal', 2, 8.5, 'arm-A2', 'Lesson from run A iter 2', 'Summary A2', '', '', now);
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sum-run-B-1', 'run-B', 'same-goal', 1, 6.0, 'arm-B1', 'Lesson from run B iter 1', 'Summary B1', '', '', now);
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sum-run-B-2', 'run-B', 'same-goal', 2, 9.0, 'arm-B2', 'Lesson from run B iter 2', 'Summary B2', '', '', now);
    // Also add a summary for a different goal
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sum-other-1', 'run-X', 'other-goal', 1, 7.5, 'arm-X', 'Other goal lesson', 'Summary X', '', '', now);
    db.close();
  });

  it('getSummaries(goalId) without runId returns ALL runs under that goal', () => {
    const db = new ExperimentMemory(TEST_DB);
    const summaries = db.getSummaries('same-goal');
    // Should include summaries from BOTH run-A and run-B
    const runIds = new Set(summaries.map(s => s.runId));
    expect(runIds.has('run-A')).toBe(true);
    expect(runIds.has('run-B')).toBe(true);
    db.close();
  });

  it('getSummaries(goalId, runId) returns only summaries for that specific run', () => {
    const db = new ExperimentMemory(TEST_DB);
    const summaries = db.getSummaries('same-goal', 'run-A');
    expect(summaries).toHaveLength(2);
    expect(summaries.every(s => s.runId === 'run-A')).toBe(true);
    db.close();
  });

  it('getSummaries with runId does not leak summaries from other runs', () => {
    const db = new ExperimentMemory(TEST_DB);
    const summaries = db.getSummaries('same-goal', 'run-B');
    expect(summaries).toHaveLength(2);
    expect(summaries.map(s => s.iteration).sort()).toEqual([1, 2]);
    const runAIds = summaries.filter(s => s.runId === 'run-A').map(s => s.id);
    expect(runAIds).toHaveLength(0);
    db.close();
  });

  it('getSummaries with runId excludes summaries from other goals', () => {
    const db = new ExperimentMemory(TEST_DB);
    const summaries = db.getSummaries('same-goal', 'run-A');
    const goalIds = new Set(summaries.map(s => s.goalId));
    expect(goalIds.has('other-goal')).toBe(false);
    db.close();
  });
});

// ── getLessons ──────────────────────────────────────────────────────────────

describe('ExperimentMemory getLessons', () => {
  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch { /* ok */ }
    const db = openTestDb();
    setupSchema(db);
    const now = new Date().toISOString();
    // Two lessons for goal-1, one for goal-2, one with empty lesson (should be excluded)
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('l1', 'r1', 'goal-1', 1, 7.0, 'arm-A', 'Do more of X', 'sum1', '', '', now);
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('l2', 'r1', 'goal-1', 2, 8.0, 'arm-B', 'Reduce Y', 'sum2', '', '', now);
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('l3', 'r2', 'goal-2', 1, 9.0, 'arm-C', 'Expand Z', 'sum3', '', '', now);
    // l4 has empty lesson — should be excluded
    db.prepare(`INSERT INTO iteration_summaries (id, run_id, goal_id, iteration, best_score, best_arm_id, lesson, summary_text, what_worked, what_didnt_work, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('l4', 'r3', 'goal-3', 1, 5.0, 'arm-D', '', 'sum4', '', '', now);
    db.close();
  });

  it('returns only lessons with non-empty lesson text', () => {
    const db = new ExperimentMemory(TEST_DB);
    const lessons = db.getLessons();
    // l4 has empty lesson and must be excluded
    expect(lessons).toHaveLength(3);
    expect(lessons.map(l => l.lesson)).not.toContain('');
    db.close();
  });

  it('filters by goalId when provided', () => {
    const db = new ExperimentMemory(TEST_DB);
    const lessons = db.getLessons('goal-1');
    expect(lessons).toHaveLength(2);
    expect(lessons.every(l => l.goalId === 'goal-1')).toBe(true);
    db.close();
  });

  it('includes runId and iteration in returned lessons', () => {
    const db = new ExperimentMemory(TEST_DB);
    const lessons = db.getLessons();
    const goal1Lessons = lessons.filter(l => l.goalId === 'goal-1');
    expect(goal1Lessons[0].runId).toBe('r1');
    expect(goal1Lessons[0].iteration).toBe(1);
    expect(goal1Lessons[1].iteration).toBe(2);
    db.close();
  });

  it('includes bestScore in returned lessons', () => {
    const db = new ExperimentMemory(TEST_DB);
    const lessons = db.getLessons();
    const l = lessons.find(l => l.goalId === 'goal-2');
    expect(l?.bestScore).toBe(9.0);
    db.close();
  });
});
