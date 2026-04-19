import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import type { ExperimentArm } from '../src/types.js';
import type { CampaignStatus } from '../src/campaign.js';

// ── Test helpers ───────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const dir = join(tmpdir(), `modelab-campaign-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
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
      PRIMARY KEY (campaign_id, run_id)
    );
  `);
  // Expose dir for cleanup
  (db as any)._testDir = dir;
  return db;
}

// ── Mock orchestrator to avoid real API calls ─────────────────────────────────

vi.mock('../src/orchestrator.js', () => {
  return {
    ResearchOrchestrator: vi.fn().mockImplementation(() => ({
      run: vi.fn().mockResolvedValue({
        runId: 'mock-run-id',
        goalId: 'mock-goal-id',
        status: 'completed' as const,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        totalCostUsd: 0.05,
        bestResult: {
          armId: 'test-arm',
          model: 'balanced',
          score: 8,
          costUsd: 0.05,
          latencyMs: 100,
          output: 'Mock response',
          durationMs: 500,
        },
        allResults: [
          {
            armId: 'test-arm',
            model: 'balanced',
            score: 8,
            costUsd: 0.05,
            latencyMs: 100,
            output: 'Mock response',
            durationMs: 500,
          },
        ],
      }),
    })),
  };
});

vi.mock('../src/memory.js', () => {
  return {
    ExperimentMemory: vi.fn().mockImplementation(() => ({
      getHistory: vi.fn().mockReturnValue([]),
      getLessons: vi.fn().mockReturnValue([]),
      getRunSummaries: vi.fn().mockReturnValue([]),
      close: vi.fn(),
    })),
  };
});

vi.mock('../src/cache.js', () => {
  return {
    Cache: vi.fn().mockImplementation(() => ({
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
      close: vi.fn(),
    })),
  };
});

vi.mock('../src/evaluator.js', () => ({
  callModel: vi.fn().mockResolvedValue(JSON.stringify({
    finding: 'Test finding',
    belief_change: 'unchanged',
    next_run_recommendation: 'Try another run',
    stop_reason: null,
    confidence: 0.5,
  })),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CampaignManager', () => {
  let db: Database.Database;
  let CampaignManager: any;
  let mgr: any;

  beforeEach(async () => {
    db = createTestDb();

    const mod = await import('../src/campaign.js');
    // Replace openDb to return our test db
    (mod as any).openDb = () => db;

    CampaignManager = mod.CampaignManager;
    mgr = new CampaignManager({
      evalModel: 'balanced',
      models: {},
      budget: { maxPerRun: 2, maxPerExperiment: 0.5, trackCosts: true },
      parallelism: 1,
    } as any);
    mgr.db = db;
  });

  afterEach(() => {
    if (mgr) {
      try { mgr.close(); } catch { /* ignore */ }
    }
    try { db.close(); } catch { /* ignore */ }
    const dir = (db as any)._testDir;
    if (dir) {
      try { unlinkSync(join(dir, 'test.db')); } catch { /* ignore */ }
    }
  });

  // ── createCampaign ─────────────────────────────────────────────────────

  it('creates a campaign with a unique id', () => {
    const c = mgr.createCampaign({ question: 'Does X work?', maxRuns: 3 });
    expect(c.id).toMatch(/^camp-\d+-[a-f0-9]+$/);
    expect(c.question).toBe('Does X work?');
    expect(c.status).toBe('planning');
    expect(c.total_runs).toBe(0);
    expect(c.max_runs).toBe(3);
  });

  it('creates a campaign with default maxRuns of 5', () => {
    const c = mgr.createCampaign({ question: 'Test question' });
    expect(c.max_runs).toBe(5);
  });

  it('creates a campaign with a hypothesis', () => {
    const c = mgr.createCampaign({ question: 'Test', hypothesis: 'X is true' });
    expect(c.hypothesis).toBe('X is true');
  });

  // ── getCampaign ────────────────────────────────────────────────────────

  it('returns null for non-existent campaign', () => {
    expect(mgr.getCampaign('camp-nonexistent')).toBeNull();
  });

  it('returns a campaign by id', () => {
    const created = mgr.createCampaign({ question: 'Find me' });
    const found = mgr.getCampaign(created.id);
    expect(found).not.toBeNull();
    expect(found!.question).toBe('Find me');
  });

  // ── listCampaigns ──────────────────────────────────────────────────────

  it('lists all campaigns — most recent first', () => {
    const c1 = mgr.createCampaign({ question: 'First' });
    const c2 = mgr.createCampaign({ question: 'Second' });
    const list = mgr.listCampaigns();
    const ids = list.map((x: any) => x.id);
    const c1Idx = ids.indexOf(c1.id);
    const c2Idx = ids.indexOf(c2.id);
    expect(c1Idx).toBeGreaterThanOrEqual(0);
    expect(c2Idx).toBeGreaterThanOrEqual(0);
    expect(c2Idx).toBeLessThan(c1Idx); // c2 is more recent, comes first
  });

  it('filters campaigns by status', () => {
    const c = mgr.createCampaign({ question: 'Test' });
    expect(mgr.listCampaigns('planning').some((x: any) => x.id === c.id)).toBe(true);
    expect(mgr.listCampaigns('running').some((x: any) => x.id === c.id)).toBe(false);
  });

  // ── pause / resume ────────────────────────────────────────────────────

  it('pauses a campaign', () => {
    const c = mgr.createCampaign({ question: 'Test' });
    const paused = mgr.pauseCampaign(c.id);
    expect(paused!.status).toBe('paused');
  });

  it('resumes a paused campaign', () => {
    const c = mgr.createCampaign({ question: 'Test' });
    mgr.pauseCampaign(c.id);
    const resumed = mgr.resumeCampaign(c.id);
    expect(resumed!.status).toBe('running');
  });

  it('does not resume a non-paused campaign', () => {
    const c = mgr.createCampaign({ question: 'Test' });
    const result = mgr.resumeCampaign(c.id);
    // Status is 'planning', not 'paused', so no-op
    expect(result!.status).toBe('planning');
  });

  // ── deleteCampaign ─────────────────────────────────────────────────────

  it('deletes a campaign', () => {
    const c = mgr.createCampaign({ question: 'Delete me' });
    mgr.deleteCampaign(c.id);
    expect(mgr.getCampaign(c.id)).toBeNull();
  });

  // ── runNext ────────────────────────────────────────────────────────────

  it('increments total_runs after runNext', async () => {
    const c = mgr.createCampaign({ question: 'Test run', maxRuns: 5 });
    expect(c.total_runs).toBe(0);

    const arms: ExperimentArm[] = [{
      id: 'test-arm',
      name: 'Test Arm',
      promptTemplate: 'Test {{question}}',
      model: 'balanced',
    }];

    const result = await mgr.runNext(c.id, arms);
    expect(result.campaign.total_runs).toBe(1);
    expect(result.runLog).toBeDefined();
    expect(result.synthesis).toBeDefined();
    expect(result.synthesis.finding).toBeTruthy();
  });

  it('throws for non-existent campaign', async () => {
    await expect(mgr.runNext('camp-fake', [])).rejects.toThrow('Campaign not found');
  });

  it('throws for already-complete campaign', async () => {
    const c = mgr.createCampaign({ question: 'Test', maxRuns: 1 });
    db.prepare(`UPDATE campaigns SET status = 'complete' WHERE id = ?`).run(c.id);
    await expect(mgr.runNext(c.id, [])).rejects.toThrow('already complete');
  });

  it('records campaign runs in campaign_runs table', async () => {
    const c = mgr.createCampaign({ question: 'Record test' });
    const arms: ExperimentArm[] = [{ id: 'arm1', name: 'Arm 1', promptTemplate: '{{question}}', model: 'balanced' }];

    await mgr.runNext(c.id, arms);

    const rows = db.prepare('SELECT * FROM campaign_runs WHERE campaign_id = ?').all(c.id) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].sequence_order).toBe(1);
    expect(rows[0].run_context).toContain('Campaign:');
    expect(rows[0].interim_finding).toBeTruthy();
  });

  it('campaign may complete after first run if clear answer found', async () => {
    // The mock returns score 8, which triggers "strong support" in rule-based synthesis
    const c = mgr.createCampaign({ question: 'Clear answer test', maxRuns: 5 });
    const arms: ExperimentArm[] = [{ id: 'arm1', name: 'Arm 1', promptTemplate: '{{question}}', model: 'balanced' }];

    const result = await mgr.runNext(c.id, arms);
    expect(result.campaign.total_runs).toBe(1);
    // Score 8 >= 4*1.5=6 → "strong support" → stop_reason: clear_answer
    if (result.campaign.status === 'complete') {
      expect(result.synthesis.stop_reason).toBe('clear_answer');
    }
    // Either way, synthesis is valid
    expect(result.synthesis.confidence).toBeGreaterThanOrEqual(0);
  });

  // ── getReport ──────────────────────────────────────────────────────────

  it('returns null for non-existent campaign report', () => {
    expect(mgr.getReport('camp-nonexistent')).toBeNull();
  });

  it('returns a report with campaign and runs', async () => {
    const c = mgr.createCampaign({ question: 'Report test', hypothesis: 'H is true' });
    const arms: ExperimentArm[] = [{ id: 'arm1', name: 'Arm 1', promptTemplate: '{{question}}', model: 'balanced' }];

    await mgr.runNext(c.id, arms);

    const report = mgr.getReport(c.id);
    expect(report).not.toBeNull();
    expect(report!.campaign.id).toBe(c.id);
    expect(report!.campaign.hypothesis).toBe('H is true');
    expect(report!.runs.length).toBe(1);
    expect(report!.runs[0].sequenceOrder).toBe(1);
  });

  // ── SELF_IMPROVEMENT_CAMPAIGN ─────────────────────────────────────────

  it('SELF_IMPROVEMENT_CAMPAIGN has valid structure', async () => {
    const { SELF_IMPROVEMENT_CAMPAIGN } = await import('../src/campaign.js');
    expect(SELF_IMPROVEMENT_CAMPAIGN.question).toBeTruthy();
    expect(SELF_IMPROVEMENT_CAMPAIGN.maxRuns).toBeGreaterThan(0);
    expect(typeof SELF_IMPROVEMENT_CAMPAIGN.buildArms).toBe('function');
    const arms = SELF_IMPROVEMENT_CAMPAIGN.buildArms();
    expect(arms.length).toBeGreaterThan(0);
    expect(arms[0].promptTemplate).toContain('{{goal}}');
  });

  // ── Synthesis ──────────────────────────────────────────────────────────

  it('synthesizes with a valid finding after a run', async () => {
    const c = mgr.createCampaign({ question: 'Synth test' });
    const arms: ExperimentArm[] = [{ id: 'arm1', name: 'Arm 1', promptTemplate: '{{question}}', model: 'balanced' }];

    const { synthesis } = await mgr.runNext(c.id, arms);
    expect(synthesis).toBeDefined();
    expect(synthesis.confidence).toBeGreaterThanOrEqual(0);
    expect(synthesis.confidence).toBeLessThanOrEqual(1);
  });

  it('synthesis returns a valid belief_change', async () => {
    const c = mgr.createCampaign({ question: 'Belief test' });
    const arms: ExperimentArm[] = [{ id: 'arm1', name: 'Arm 1', promptTemplate: '{{question}}', model: 'balanced' }];

    const { synthesis } = await mgr.runNext(c.id, arms);
    expect(['strengthened', 'weakened', 'unchanged', 'inconclusive']).toContain(synthesis.belief_change);
  });

  it('forceSynthesize updates campaign findings', async () => {
    const c = mgr.createCampaign({ question: 'Force synth test' });
    const arms: ExperimentArm[] = [{ id: 'arm1', name: 'Arm 1', promptTemplate: '{{question}}', model: 'balanced' }];

    await mgr.runNext(c.id, arms);

    const synthesis = await mgr.forceSynthesize(c.id);
    expect(synthesis).toBeDefined();
    expect(synthesis.finding).toBeTruthy();

    // Campaign findings should be updated
    const updated = mgr.getCampaign(c.id);
    expect(updated!.findings).toBeTruthy();
  });
});
