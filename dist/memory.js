import Database from 'better-sqlite3';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
/** Task-type keyword detectors (same logic as router.ts) */
const CODE_KEYWORDS = /\b(code|function|refactor|bug|fix|test|build|repo|pull.request|pr\b|typescript|javascript|python|rust|compile|lint|eslint|prettier|npm|yarn|cargo)\b/i;
const REASON_KEYWORDS = /\b(reason|proof|logic|analysis|analyze|theorem|prove|conjecture|derive|evaluate|compare|contrast|critique|synthesis|reasoning.step|step.by.step|glm-5|glm5|glm-4.7|glm4.7|glm-5.1|glm5.1|glm4\b)/i;
const QUICK_KEYWORDS = /\b(quick|small|summary|brief|one.liner|quick.summary|what.is|define|lookup)\b/i;
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
      output_preview TEXT  NOT NULL DEFAULT '',
      output_truncated INTEGER NOT NULL DEFAULT 0,
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
function armId(base) {
    return base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
}
export class ExperimentMemory {
    /** @internal */
    db;
    constructor(dbPath) {
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
          output_preview TEXT  NOT NULL DEFAULT '',
          output_truncated INTEGER NOT NULL DEFAULT 0,
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
    log(result, runId, goalId) {
        const stmt = this.db.prepare(`
      INSERT INTO experiments
        (id, run_id, goal_id, arm_id, score, cost_usd, input_tokens, output_tokens,
         output, output_preview, output_truncated, model, duration_ms, latency_ms, iteration, timestamp)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(`${armId(result.armId)}-${Date.now()}`, runId, goalId, result.armId, result.score, result.costUsd, result.tokensUsed.input, result.tokensUsed.output, result.output, result.outputPreview ?? result.output.slice(0, 200), result.outputTruncated ? 1 : 0, result.model, result.durationMs, result.latencyMs ?? 0, result.iteration, result.timestamp);
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
    summarize(runId, goalId, iteration, results) {
        const scored = results.filter(r => r.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const best = scored[0] ?? null;
        const worst = scored[scored.length - 1] ?? null;
        const whatWorked = best && best.output
            ? best.output.slice(0, 500)
            : '';
        const whatDidntWork = worst && worst.output && worst.score !== null && worst.score < (best?.score ?? 10)
            ? worst.output.slice(0, 300)
            : '';
        // ── Trend detection ────────────────────────────────────────────────────────
        // Pull all prior iterations for this goal+run to detect score trajectory
        const priorForGoal = this.getSummaries(goalId, runId)
            .filter(s => s.iteration < iteration)
            .map(s => s.bestScore)
            .filter((s) => s !== null);
        const allScores = [...priorForGoal, best?.score ?? null].filter((s) => s !== null);
        let trend = 'unknown';
        if (allScores.length >= 2) {
            const recent = allScores.slice(-3);
            if (recent.length >= 2) {
                const delta = recent[recent.length - 1] - recent[0];
                if (delta > 1)
                    trend = 'improving';
                else if (delta < -1)
                    trend = 'declining';
                else
                    trend = 'stable';
            }
        }
        // ── Per-arm-family scores across ALL prior runs (not just this run) ─────────
        const armFamilyScores = new Map();
        const allPriorResults = this.getHistory(goalId).filter(r => r.runId !== runId && r.score !== null);
        for (const r of allPriorResults) {
            const family = r.armId.replace(/(_t[0-9.]+)+$/, '').replace(/[._-]temp[0-9.]+$/, '');
            (armFamilyScores.get(family) ?? []).push(r.score ?? 0);
        }
        // Find the best arm family overall (excluding the current run's best to avoid tautology)
        let topFamilyAdvice = '';
        if (armFamilyScores.size > 0) {
            const familyAverages = [...armFamilyScores.entries()]
                .map(([family, scores]) => ({ family, avg: scores.reduce((s, v) => s + v, 0) / scores.length }))
                .sort((a, b) => b.avg - a.avg);
            if (familyAverages[0] && best && familyAverages[0].family !== best.armId.replace(/(_t[0-9.]+)+$/, '').replace(/[._-]temp[0-9.]+$/, '')) {
                topFamilyAdvice = ` · Prior runs suggest "${familyAverages[0].family}" averages ${familyAverages[0].avg.toFixed(1)}/10 across prior experiments`;
            }
        }
        // ── Convergence check: are all arms scoring similarly (plateau signal)? ─────
        let convergenceAdvice = '';
        if (scored.length >= 2) {
            const spread = (scored[0].score ?? 0) - (scored[scored.length - 1].score ?? 0);
            if (spread < 1) {
                convergenceAdvice = ' · Arms are converging — consider trying a different model family or prompt strategy to break the plateau';
            }
        }
        // ── Build lesson ──────────────────────────────────────────────────────────
        const trendStr = trend === 'improving' ? ' (improving ↑)' : trend === 'declining' ? ' (declining ↓)' : trend === 'stable' ? ' (stable →)' : '';
        let lesson = '';
        if (best && worst && best.score !== null && worst.score !== null) {
            const diff = best.score - worst.score;
            if (diff > 2) {
                lesson = `${best.armId} outperformed ${worst.armId} by ${diff.toFixed(1)} points — prefer this approach${trendStr}${topFamilyAdvice}${convergenceAdvice}`;
            }
            else if (best.score >= 8) {
                lesson = `${best.armId} achieved high quality (${best.score}/10)${trendStr}${topFamilyAdvice}`;
            }
            else if (best.score >= 5) {
                lesson = `Best score ${best.score}/10${trendStr}${topFamilyAdvice}${convergenceAdvice}`;
            }
            else {
                lesson = `Low quality scores (best: ${best.score}/10)${trendStr} — consider prompt restructuring or a stronger model${topFamilyAdvice}`;
            }
        }
        else if (best) {
            lesson = `Best so far: ${best.armId} at ${best.score}/10${trendStr}${topFamilyAdvice}`;
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
        stmt.run(id, runId, goalId, iteration, best?.score ?? null, best?.armId ?? null, bestLatencyArm?.latencyMs ?? null, whatWorked, whatDidntWork, lesson, summaryText, new Date().toISOString());
        return {
            id, runId, goalId, iteration,
            bestScore: best?.score ?? null,
            bestArmId: best?.armId ?? null,
            bestLatencyMs: bestLatencyArm?.latencyMs ?? null,
            whatWorked, whatDidntWork, lesson, summaryText,
            createdAt: new Date().toISOString(),
        };
    }
    getSummaries(goalId, runId) {
        const sql = runId
            ? `SELECT * FROM iteration_summaries WHERE goal_id = ? AND run_id = ? ORDER BY iteration ASC`
            : `SELECT * FROM iteration_summaries WHERE goal_id = ? ORDER BY iteration ASC`;
        const rows = (runId
            ? this.db.prepare(sql).all(goalId, runId)
            : this.db.prepare(sql).all(goalId));
        return rows.map(mapSummaryRow);
    }
    getContextForIteration(goalId, runId, iter) {
        // Cross-run learning: pull summaries from ALL prior runs of this goal,
        // not just the current run, so iteration N can learn from run N-1's outcomes.
        const priorSummaries = this.getSummaries(goalId)
            .filter(s => s.iteration < iter);
        const allPrior = this.getHistory(goalId)
            .filter(r => r.iteration < iter);
        const bestOverall = allPrior
            .filter(r => r.score !== null)
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;
        // ── Per-arm model performance history ─────────────────────────────────
        // Which models and temperatures have worked best for each arm id pattern?
        // We group by arm prefix (e.g. "arm-claude-sonnet" from "arm-claude-sonnet_t0_3")
        // to generalise across temperature-sweep variants.
        const armModelScores = new Map();
        for (const r of allPrior) {
            if (r.score === null)
                continue;
            // Strip temperature suffix from arm id to get the arm family
            const armFamily = r.armId.replace(/(_t[0-9.]+)+$/, '').replace(/[._-]temp[0-9.]+$/, '');
            const armEntry = armModelScores.get(armFamily) ?? [];
            // Extract temperature from arm id if present (temperature sweep arms embed it)
            const tempMatch = r.armId.match(/_t([0-9.]+)/);
            const temp = tempMatch ? parseFloat(tempMatch[1]) : undefined;
            armEntry.push({ model: r.model, score: r.score, ...(temp !== undefined ? { temp } : {}) });
            armModelScores.set(armFamily, armEntry);
        }
        const armModelAdvice = [];
        for (const [armFamily, entries] of armModelScores) {
            // Find the best-scoring model for this arm family
            const byModel = new Map();
            const byTemp = new Map();
            for (const e of entries) {
                (byModel.get(e.model) ?? []).push(e.score);
                if (e.temp !== undefined)
                    (byTemp.get(String(e.temp)) ?? []).push(e.score);
            }
            const bestModel = [...byModel.entries()].sort((a, b) => b[1].reduce((s, v) => s + v, 0) / b[1].length - a[1].reduce((s, v) => s + v, 0) / a[1].length)[0];
            const bestTemp = byTemp.size > 0
                ? [...byTemp.entries()].sort((a, b) => b[1].reduce((s, v) => s + v, 0) / b[1].length - a[1].reduce((s, v) => s + v, 0) / a[1].length)[0]
                : null;
            if (bestModel) {
                const avgScore = bestModel[1].reduce((s, v) => s + v, 0) / bestModel[1].length;
                armModelAdvice.push(`**${armFamily}:** prefer ${bestModel[0]} (avg score ${avgScore.toFixed(1)}/10)${bestTemp ? `, temperature ${bestTemp[0]} (avg ${(bestTemp[1].reduce((s, v) => s + v, 0) / bestTemp[1].length).toFixed(1)}/10)` : ''}`);
            }
        }
        // ── Cross-run lessons ──────────────────────────────────────────────────
        const runSummaries = this.getRunSummaries(goalId);
        const priorRunLessons = runSummaries
            .filter(rs => rs.runId !== runId)
            .slice(0, 3)
            .map(rs => `Run ${rs.runId.slice(0, 8)}: ${rs.lesson}`);
        let contextString = '';
        if (priorSummaries.length > 0 || armModelAdvice.length > 0 || priorRunLessons.length > 0) {
            const sections = [];
            if (priorSummaries.length > 0) {
                sections.push(`## Prior Iteration Results (${priorSummaries.length} prior iteration${priorSummaries.length !== 1 ? 's' : ''})`, ...priorSummaries.map(s => {
                    const lines = [`### Iteration ${s.iteration} — ${s.bestArmId ?? '?'} scored ${s.bestScore ?? 'N/A'}/10`];
                    if (s.lesson)
                        lines.push(`**Lesson:** ${s.lesson}`);
                    if (s.whatWorked)
                        lines.push(`**What worked:** ${s.whatWorked.slice(0, 200)}`);
                    if (s.whatDidntWork)
                        lines.push(`**What didn't work:** ${s.whatDidntWork.slice(0, 200)}`);
                    return lines.join('\n');
                }));
            }
            if (armModelAdvice.length > 0) {
                sections.push('## Per-Arm Model Preferences (learned from history)', ...armModelAdvice);
            }
            if (priorRunLessons.length > 0) {
                sections.push('## Prior Run Lessons', ...priorRunLessons);
            }
            // ── Build actionable guidance for the next iteration ─────────────────────
            const scoredArms = allPrior.filter(r => r.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
            const avgScore = scoredArms.length > 0
                ? scoredArms.reduce((s, r) => s + (r.score ?? 0), 0) / scoredArms.length
                : null;
            // Identify the worst-performing model families to avoid
            const worstFamilies = [...armModelScores.entries()]
                .map(([family, entries]) => ({ family, avg: entries.reduce((s, e) => s + e.score, 0) / entries.length }))
                .filter(e => e.avg < (avgScore ?? 5) - 1)
                .sort((a, b) => a.avg - b.avg)
                .slice(0, 2);
            const avoidAdvice = worstFamilies.length > 0
                ? ` · Avoid: ${worstFamilies.map(w => `${w.family} (avg ${w.avg.toFixed(1)}/10)`).join(', ')}`
                : '';
            // Latency signal: if fastest arm scored well, flag it
            const fastGood = allPrior
                .filter(r => r.latencyMs > 0 && r.score !== null)
                .sort((a, b) => (a.latencyMs ?? 0) - (b.latencyMs ?? 0))[0];
            const latencyAdvice = fastGood && (fastGood.score ?? 0) >= (avgScore ?? 7)
                ? ` · ${fastGood.armId} delivers good quality at ${fastGood.latencyMs}ms TTFT — consider for latency-sensitive use cases`
                : '';
            const guidanceLines = [];
            // Prior iteration lessons: chain the distilled lesson from the most recent iteration.
            // This is the "here's what we learned last time" signal that closes the feedback loop
            // between iteration N and iteration N+1 — highest-impact per the GLM audit.
            if (priorSummaries.length > 0) {
                const mostRecent = priorSummaries[priorSummaries.length - 1];
                if (mostRecent.lesson) {
                    guidanceLines.push(`Previous lesson: "${mostRecent.lesson}". Apply this directly to the next iteration.`);
                }
            }
            if (bestOverall) {
                guidanceLines.push(`Best approach so far: ${bestOverall.armId} (${bestOverall.score}/10). Build on what worked and avoid what didn't.`);
            }
            else {
                guidanceLines.push('No prior iterations with scored results yet.');
            }
            if (avgScore !== null)
                guidanceLines.push(`Average score across prior arms: ${avgScore.toFixed(1)}/10.`);
            if (armModelAdvice.length > 0)
                guidanceLines.push(`Model preferences: ${armModelAdvice.slice(0, 3).join('; ')}.`);
            if (avoidAdvice)
                guidanceLines.push(`Performance warnings:${avoidAdvice}`);
            if (latencyAdvice)
                guidanceLines.push(`Latency insight:${latencyAdvice}`);
            // Compute trend from all prior results (stable across the guidance block)
            const trendScores = allPrior.filter(r => r.score !== null).map(r => r.score ?? 0);
            let trend = 'unknown';
            if (trendScores.length >= 3) {
                const recent = trendScores.slice(-3);
                const delta = recent[recent.length - 1] - recent[0];
                if (delta > 1)
                    trend = 'improving';
                else if (delta < -1)
                    trend = 'declining';
                else
                    trend = 'stable';
            }
            if (scoredArms.length >= 5 && trend !== 'unknown') {
                const trendAdvice = trend === 'improving'
                    ? 'Score is improving — current approach is working, keep iterating'
                    : trend === 'declining'
                        ? 'Score is declining — try a different prompt strategy or model'
                        : 'Score is stable — consider varying temperature or switching model family';
                guidanceLines.push(`Trend signal: ${trendAdvice}`);
            }
            sections.push('## Guidance for Next Iteration', ...guidanceLines);
            contextString = sections.join('\n');
        }
        return {
            iteration: iter,
            priorIterations: priorSummaries,
            bestScoreSoFar: bestOverall?.score ?? null,
            bestArmSoFar: bestOverall?.armId ?? null,
            contextString,
        };
    }
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
    summarizeRun(runId, goalId, status, startedAt, completedAt, allResults) {
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
            }
            else if (bestResult && bestResult.score !== null && bestResult.score >= 8) {
                lesson = `Achieved quality threshold with best score ${bestResult.score}/10 from ${bestResult.armId}`;
            }
            else {
                lesson = `Ran ${totalIterations} iterations, best score ${bestResult?.score ?? 'N/A'}/10 — consider adjusting prompts or models`;
            }
        }
        else if (iterationSummaries.length === 1) {
            const s = iterationSummaries[0];
            lesson = s.lesson || `Single iteration run — best ${s.bestArmId ?? '?'} scored ${s.bestScore ?? 'N/A'}/10`;
        }
        else {
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
        stmt.run(runId, goalId, status, totalCostUsd, totalArms, totalIterations, bestResult?.score ?? null, bestResult?.armId ?? null, bestResult ? (allResults.indexOf(bestResult) + 1) : null, latencyStats.bestMs ?? null, avgLatencyMs, startedAt, completedAt, durationMs, lesson, report, new Date().toISOString());
        return {
            runId, goalId, status, totalCostUsd, totalArms, totalIterations,
            bestScore: bestResult?.score ?? null,
            bestArmId: bestResult?.armId ?? null,
            bestIteration: bestResult ? (allResults.indexOf(bestResult) + 1) : null,
            startedAt, completedAt, durationMs,
            iterationSummaries, lesson, report, latencyStats, avgLatencyMs,
        };
    }
    getRunSummaries(goalId) {
        const sql = goalId
            ? `SELECT * FROM run_summaries WHERE goal_id = ? ORDER BY created_at DESC`
            : `SELECT * FROM run_summaries ORDER BY created_at DESC`;
        const rows = (goalId
            ? this.db.prepare(sql).all(goalId)
            : this.db.prepare(sql).all());
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
    getRun(runId) {
        const rows = this.db.prepare(`SELECT * FROM run_summaries WHERE run_id = ?`).all(runId);
        if (rows.length === 0)
            return null;
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
    _latencyStatsForRun(runId) {
        const rows = this.db.prepare(`SELECT latency_ms, arm_id FROM experiments WHERE run_id = ? AND latency_ms > 0`).all(runId);
        if (rows.length === 0) {
            return { avgMs: 0, p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0, sampleCount: 0, bestMs: null, bestArmId: null };
        }
        const sorted = [...rows].sort((a, b) => a.latency_ms - b.latency_ms);
        const latencies = sorted.map(r => r.latency_ms);
        const n = latencies.length;
        const bestRow = sorted[0];
        return {
            avgMs: Math.round(latencies.reduce((s, v) => s + v, 0) / n),
            p50Ms: latencies[Math.floor(n * 0.50)],
            p95Ms: latencies[Math.floor(n * 0.95)],
            minMs: sorted[0].latency_ms,
            maxMs: sorted[n - 1].latency_ms,
            sampleCount: n,
            bestMs: bestRow.latency_ms,
            bestArmId: bestRow.arm_id,
        };
    }
    /**
     * Returns per-(arm family, task type, temperature) insights from all stored
     * experiment results. Task type is inferred from the goal question keywords.
     */
    getModelInsights() {
        const results = this.getHistory();
        if (results.length === 0)
            return [];
        // Infer task type per result from its goal question (stored in run report)
        const taskTypeMap = new Map();
        const runSummaries = this.getRunSummaries();
        for (const run of runSummaries) {
            const question = this._extractQuestionFromReport(run.report);
            if (question)
                taskTypeMap.set(run.goalId, _inferTaskType(question));
        }
        // Group by (armFamily, taskType, temperature)
        const groups = new Map();
        for (const r of results) {
            if (r.score === null)
                continue;
            const taskType = taskTypeMap.get(r.goalId) ?? 'general';
            const tempMatch = r.armId.match(/_t([0-9.]+)/);
            const temperature = tempMatch ? parseFloat(tempMatch[1]) : null;
            const armFamily = r.armId.replace(/(_t[0-9.]+)+$/, '').replace(/[._-]temp[0-9.]+$/, '');
            const key = `${armFamily}\x00${taskType}\x00${temperature ?? ''}`;
            let g = groups.get(key);
            if (!g) {
                g = { armFamily, provider: r.model, model: r.model, taskType, temperature,
                    scores: [], latencies: [], costs: [], bestScore: null,
                    wins: 0, total: 0, lastUsed: null };
                groups.set(key, g);
            }
            g.scores.push(r.score);
            if (r.latencyMs > 0)
                g.latencies.push(r.latencyMs);
            g.costs.push(r.costUsd);
            if (g.bestScore === null || r.score > g.bestScore)
                g.bestScore = r.score;
            if (g.lastUsed === null || r.timestamp > g.lastUsed)
                g.lastUsed = r.timestamp;
            g.total++;
        }
        // Win rate: per-run best arm
        const runBestMap = new Map();
        for (const r of results) {
            if (r.score === null)
                continue;
            const existing = runBestMap.get(r.runId);
            if (!existing || r.score > existing.score) {
                const armFamily = r.armId.replace(/(_t[0-9.]+)+$/, '').replace(/[._-]temp[0-9.]+$/, '');
                runBestMap.set(r.runId, { armFamily, score: r.score });
            }
        }
        for (const { armFamily } of new Set(runBestMap.values())) {
            const g = [...groups.values()].find(gr => gr.armFamily === armFamily);
            if (g)
                g.wins++;
        }
        const insights = [];
        for (const g of groups.values()) {
            if (g.scores.length === 0)
                continue;
            const avgScore = g.scores.reduce((s, v) => s + v, 0) / g.scores.length;
            const avgLatency = g.latencies.length > 0 ? g.latencies.reduce((s, v) => s + v, 0) / g.latencies.length : null;
            const avgCost = g.costs.reduce((s, v) => s + v, 0) / g.costs.length;
            const winRate = runBestMap.size > 0 ? g.wins / runBestMap.size : 0;
            let verdict = '';
            if (avgScore >= 8)
                verdict = `Strong performer (avg ${avgScore.toFixed(1)}/10, n=${g.scores.length})`;
            else if (avgScore >= 6)
                verdict = `Solid choice (avg ${avgScore.toFixed(1)}/10, n=${g.scores.length})`;
            else if (avgScore >= 4)
                verdict = `Below average (avg ${avgScore.toFixed(1)}/10, n=${g.scores.length})`;
            else
                verdict = `Poor results (avg ${avgScore.toFixed(1)}/10, n=${g.scores.length})`;
            if (winRate > 0.3)
                verdict += ` · ${(winRate * 100).toFixed(0)}% run wins`;
            if (avgLatency !== null && avgLatency < 2000)
                verdict += ` · fast TTFT ${Math.round(avgLatency)}ms`;
            insights.push({
                armFamily: g.armFamily, provider: g.provider, model: g.model,
                taskType: g.taskType, temperature: g.temperature,
                sampleSize: g.scores.length, avgScore,
                avgLatencyMs: avgLatency, avgCostUsd: avgCost,
                bestScore: g.bestScore, winRate, lastUsed: g.lastUsed, verdict,
            });
        }
        return insights.sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));
    }
    /**
     * Returns aggregate statistics across all runs or a specific goal.
     */
    getAggregateStats(goalId) {
        const results = this.getHistory(goalId);
        const runs = this.getRunSummaries(goalId);
        const scored = results.filter(r => r.score !== null);
        const latencies = results.map(r => r.latencyMs).filter(ms => ms > 0).sort((a, b) => a - b);
        // Per-model arm count
        const armsByModel = {};
        for (const r of results) {
            armsByModel[r.model] = (armsByModel[r.model] ?? 0) + 1;
        }
        // Runs by status
        const runsByStatus = {};
        for (const run of runs) {
            runsByStatus[run.status] = (runsByStatus[run.status] ?? 0) + 1;
        }
        // Per-run iteration counts
        const runIterationCounts = new Map();
        for (const r of results) {
            const existing = runIterationCounts.get(r.runId) ?? 0;
            runIterationCounts.set(r.runId, Math.max(existing, r.iteration));
        }
        const totalIterations = [...runIterationCounts.values()].reduce((s, v) => s + v, 0);
        // Best run
        let bestRunId = null;
        let bestScore = null;
        let bestArmId = null;
        for (const r of scored) {
            if (bestScore === null || r.score > bestScore) {
                bestScore = r.score;
                bestArmId = r.armId;
                bestRunId = r.runId;
            }
        }
        const avgScore = scored.length > 0
            ? scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length
            : null;
        const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
        const totalRuns = runs.length;
        const avgCostPerRun = totalRuns > 0 ? totalCost / totalRuns : 0;
        const avgIterationsPerRun = totalRuns > 0 ? totalIterations / totalRuns : null;
        // Unique goals
        const goalIds = new Set(runs.map(r => r.goalId));
        // Latency stats
        const avgLatencyMs = latencies.length > 0
            ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
            : null;
        const p50LatencyMs = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.50)] : null;
        const p95LatencyMs = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : null;
        const bestLatencyEntry = latencies.length > 0 ? results.find(r => r.latencyMs === latencies[0]) : null;
        return {
            totalRuns,
            totalArmRuns: results.length,
            totalIterations,
            totalCostUsd: Math.round(totalCost * 1e6) / 1e6,
            avgCostPerRun: Math.round(avgCostPerRun * 1e6) / 1e6,
            avgScore: avgScore !== null ? Math.round(avgScore * 100) / 100 : null,
            bestScore,
            bestArmId,
            bestRunId,
            avgLatencyMs,
            p50LatencyMs,
            p95LatencyMs,
            bestLatencyMs: latencies.length > 0 ? latencies[0] : null,
            bestLatencyArmId: bestLatencyEntry?.armId ?? null,
            runsByStatus,
            armsByModel,
            goalsStudied: goalIds.size,
            avgIterationsPerRun: avgIterationsPerRun !== null ? Math.round(avgIterationsPerRun * 100) / 100 : null,
        };
    }
    _extractQuestionFromReport(report) {
        const match = report.match(/Question:\s*(.+?)(?:\n|$)/i);
        return match ? match[1].trim() : null;
    }
    close() {
        this.db.close();
    }
}
function _inferTaskType(question) {
    if (CODE_KEYWORDS.test(question))
        return 'coding';
    if (REASON_KEYWORDS.test(question))
        return 'reasoning';
    if (QUICK_KEYWORDS.test(question))
        return 'quick';
    return 'general';
}
// calcLatencyStats is now an instance method _latencyStatsForRun — kept here for any direct callers
export function calcLatencyStats(results) {
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
function mapSummaryRow(r) {
    return {
        id: r.id, runId: r.run_id, goalId: r.goal_id, iteration: r.iteration,
        bestScore: r.best_score, bestArmId: r.best_arm_id,
        bestLatencyMs: r.best_latency_ms ?? null,
        whatWorked: r.what_worked, whatDidntWork: r.what_didnt_work,
        lesson: r.lesson, summaryText: r.summary_text, createdAt: r.created_at,
    };
}
function mapRow(r) {
    return {
        armId: r.arm_id, model: r.model, output: r.output,
        outputPreview: r.output_preview,
        outputTruncated: Boolean(r.output_truncated),
        score: r.score ?? null, costUsd: r.cost_usd,
        tokensUsed: { input: r.input_tokens, output: r.output_tokens },
        durationMs: r.duration_ms, latencyMs: r.latency_ms ?? 0,
        timestamp: r.timestamp, iteration: r.iteration,
        runId: r.run_id, goalId: r.goal_id,
    };
}
//# sourceMappingURL=memory.js.map