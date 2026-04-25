/**
 * Learned Routing — v2
 *
 * Replaces the keyword-based router (router.ts) with a performance-based
 * routing system that uses actual model performance data and past run history.
 *
 * Key idea: routing should LEARN from past runs, not just match keywords.
 */
import { routeTask as oldRouteTask } from './router.js';
import { getLessonEngine } from './lesson_engine.js';
// ── Task profiling helpers ───────────────────────────────────────────────────
const TASK_TYPE_KEYWORDS = {
    code: /\b(code|function|class|method|refactor|bug|fix|test|build|repo|pull.request|pr\b|typescript|javascript|python|rust|compile|lint|eslint|prettier|npm|yarn|cargo|script|algorithm|implement|debug)\b/i,
    reasoning: /\b(reason|proof|logic|analysis|analyze|theorem|prove|conjecture|derive|evaluate|compare|contrast|critique|synthesis|reasoning.step|step.by.step|glm-5|glm5|glm-4.7|glm4.7|glm-5.1|glm5.1|glm-5.0|glm5.0|glm4|math|prove|disprove|hypothesis)\b/i,
    creative: /\b(write|story|poem|creative|fiction|artist|draw|paint|compose|imagine|invent|design|brainstorm|generate.*new|original.*idea)\b/i,
    factual: /\b(what.is|who.is|when|did|does|fact|true.false|define|lookup|look.up|search|question|answer|capital|population|history|definition)\b/i,
    analysis: /\b(analyze|compare|contrast|evaluate|critique|assess|review|investigate|examine|study|deeper|break.down|pattern|trend)\b/i,
    general: /\b(help|explain|what|how|why|tell|give|find|make|do|list|summarize)\b/i,
};
/** Infer task type from goal text */
export function inferTaskType(task) {
    for (const [type, regex] of Object.entries(TASK_TYPE_KEYWORDS)) {
        if (regex.test(task))
            return type;
    }
    return 'general';
}
/** Estimate task complexity from structural heuristics */
function estimateTaskComplexity(task) {
    let score = 3; // base complexity
    // Length-based complexity
    const wordCount = task.split(/\s+/).length;
    if (wordCount > 50)
        score += 2;
    else if (wordCount > 20)
        score += 1;
    // Question marks (more questions = more complex)
    const questionCount = (task.match(/\?/g) || []).length;
    score += Math.min(questionCount, 3);
    // Explicit complexity signals
    if (/\b(complex|detailed|thorough|in.depth|comprehensive|advanced|sophisticated)\b/i.test(task))
        score += 2;
    if (/\b(simple|basic|quick|brief|one.sentence|one.liner|summary)\b/i.test(task))
        score -= 1;
    // Structural complexity
    if (/\b(first|then|finally|step|sequence|list|enumerate)\b/i.test(task))
        score += 1;
    if (/markdown|table|list|bullet/i.test(task))
        score += 0.5;
    return Math.max(1, Math.min(10, Math.round(score)));
}
/** Build a full TaskProfile from goal text */
export function buildTaskProfile(task, mode = 'quality') {
    const taskType = inferTaskType(task);
    const complexity = estimateTaskComplexity(task);
    let latencyPriority = false;
    let costPriority = false;
    if (mode === 'latency')
        latencyPriority = true;
    if (mode === 'cost')
        costPriority = true;
    // Also infer from explicit keywords in the task text
    if (/\b(fast|quick|rapid|speed|low.latency|interactive|real.time)\b/i.test(task))
        latencyPriority = true;
    if (/\b(cheap|budget|cost.effective|affordable|low.cost|save)\b/i.test(task))
        costPriority = true;
    return { taskType, complexity, latencyPriority, costPriority, raw: task };
}
// ── Score model for a given task ─────────────────────────────────────────────
/**
 * Score a model for a given task profile.
 * Returns a score in [0, 1] where higher = better match.
 */
function scoreModelForTask(profile, task, mode) {
    let s = 0;
    const reasons = [];
    // ── Base: task-type strength match ──────────────────────────────────────
    const strengthMatch = profile.strengths.includes(task.taskType);
    const weaknessMatch = profile.weaknesses.includes(task.taskType);
    if (strengthMatch && !weaknessMatch) {
        s += 0.5;
        reasons.push(`strong on ${task.taskType}`);
    }
    else if (weaknessMatch) {
        s -= 0.4;
        reasons.push(`weak on ${task.taskType}`);
    }
    else {
        s += 0.1; // neutral baseline
    }
    // ── Quality mode: prefer high-avg-score models ─────────────────────────
    if (mode === 'quality') {
        const normScore = Math.min(profile.avgScore / 10, 1);
        s += normScore * 0.3;
        if (normScore >= 0.8)
            reasons.push(`high avg score (${profile.avgScore.toFixed(1)}/10)`);
    }
    // ── Latency mode: penalise slow models ─────────────────────────────────
    if (mode === 'latency' && profile.avgLatencyMs !== null) {
        // Penalise models above 2000ms TTFT
        const latencyPenalty = Math.min(profile.avgLatencyMs / 10_000, 0.5);
        s += 0.2 - latencyPenalty;
        if (profile.avgLatencyMs < 2000)
            reasons.push(`fast TTFT (${Math.round(profile.avgLatencyMs)}ms)`);
    }
    // ── Cost mode: prefer cheap models ───────────────────────────────────────
    if (mode === 'cost' && profile.avgCostUsd !== null) {
        // Assume $0.05/run is cheap, $1/run is expensive
        const costScore = Math.max(0, 1 - profile.avgCostUsd / 1);
        s += costScore * 0.3;
        if (profile.avgCostUsd < 0.05)
            reasons.push(`low cost ($${profile.avgCostUsd.toFixed(4)}/run)`);
    }
    // ── Complexity matching ─────────────────────────────────────────────────
    // High-complexity tasks prefer models with more sample history (more reliable)
    if (task.complexity >= 7 && profile.sampleSize >= 5) {
        s += 0.1;
        reasons.push('proven on complex tasks');
    }
    // ── Normalise ─────────────────────────────────────────────────────────────
    s = Math.max(0, Math.min(1, s));
    return { score: s, reason: reasons.join(' · ') || 'general purpose' };
}
/**
 * Find past runs with similar goals using cosine similarity on term frequency.
 * Returns models that performed well/poorly on similar tasks.
 */
function findSimilarPastRuns(task, memory) {
    if (!memory)
        return [];
    const history = memory.getHistory();
    if (history.length === 0)
        return [];
    // Build term-frequency vector for the current task
    const taskTerms = tokenise(task);
    const taskVec = buildTermFreq(taskTerms);
    const results = [];
    // Group by goalId, get the best result per goalId
    const bestByGoal = new Map();
    for (const r of history) {
        if (r.score === null)
            continue;
        const existing = bestByGoal.get(r.goalId);
        if (!existing || (r.score ?? 0) > (existing.score ?? 0)) {
            bestByGoal.set(r.goalId, r);
        }
    }
    for (const [goalId, result] of bestByGoal) {
        // We don't have the original goal question stored in ExperimentResult directly.
        // Use a heuristic: approximate using the result's armId + score as a proxy.
        // In practice this uses the run_summaries report to extract the question.
        const runSummaries = memory.getRunSummaries(goalId);
        if (runSummaries.length === 0)
            continue;
        const report = runSummaries[0]?.report ?? '';
        const questionMatch = report.match(/Question:\s*(.+?)(?:\n|$)/i);
        if (!questionMatch)
            continue;
        const pastQuestion = questionMatch[1].trim();
        const pastTerms = tokenise(pastQuestion);
        const pastVec = buildTermFreq(pastTerms);
        const similarity = cosineSimilarity(taskVec, pastVec);
        if (similarity > 0.7) {
            results.push({
                similarGoalKey: goalId,
                bestModelKeyForGoal: result.modelKey, // config key (e.g. "balanced"), not actual model name
                bestScoreForGoal: result.score ?? 0,
                cosineSimilarity: similarity,
            });
        }
    }
    return results;
}
function tokenise(text) {
    return text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2);
}
function buildTermFreq(terms) {
    const freq = new Map();
    for (const t of terms) {
        freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    return freq;
}
function cosineSimilarity(a, b) {
    const allKeys = new Set([...a.keys(), ...b.keys()]);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const k of allKeys) {
        const va = a.get(k) ?? 0;
        const vb = b.get(k) ?? 0;
        dot += va * vb;
        normA += va * va;
        normB += vb * vb;
    }
    if (normA === 0 || normB === 0)
        return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
/**
 * Apply history-based boost/penalty to a model's score.
 */
function applyHistoryBoost(candidates, pastRuns) {
    if (pastRuns.length === 0)
        return candidates;
    const boostMap = new Map();
    const similarityMap = new Map();
    for (const ctx of pastRuns) {
        const existing = boostMap.get(ctx.bestModelKeyForGoal) ?? 0;
        const boost = ctx.cosineSimilarity * (ctx.bestScoreForGoal / 10);
        boostMap.set(ctx.bestModelKeyForGoal, existing + boost);
        const prevSim = similarityMap.get(ctx.bestModelKeyForGoal) ?? 0;
        if (ctx.cosineSimilarity > prevSim)
            similarityMap.set(ctx.bestModelKeyForGoal, ctx.cosineSimilarity);
    }
    return candidates.map(c => {
        const boost = boostMap.get(c.key) ?? 0; // c.key = config key, matches modelKey from history
        const capped = Math.min(boost, 0.3);
        const sim = similarityMap.get(c.key);
        return {
            ...c,
            score: Math.min(1, c.score + capped),
            historyBoost: capped,
            boostedByPastRun: boost > 0,
            reason: capped > 0.05 && sim !== undefined
                ? `${c.reason} · boosted by past run (similarity ${sim.toFixed(2)})`
                : c.reason,
        };
    });
}
// ── Main routing function ─────────────────────────────────────────────────────
/**
 * Route a task to the best-fit model using learned performance profiles.
 *
 * @param task           Goal/task text
 * @param modelConfigs   Available model configs (key → config)
 * @param mode           Routing mode: quality, latency, or cost
 * @param memory         Optional ExperimentMemory for history-based boosting
 * @returns              Full routing decision with reasoning
 */
export function routeTaskV2(task, modelConfigs, mode = 'quality', memory) {
    // 1. Build task profile
    const taskProfile = buildTaskProfile(task, mode);
    // 2. Get the old keyword router's decision (for comparison)
    const fallbackDecision = oldRouteTask(task, modelConfigs, mode);
    // 3. Build model profiles from history
    const modelProfiles = buildModelProfiles(modelConfigs, memory);
    // 3b. Apply learned adjustments from lesson_engine (router_adjustments table)
    const lesson = getLessonEngine();
    for (const profile of modelProfiles) {
        const adj = lesson.resolveAdjustments(profile.key);
        if (adj.delta !== 0) {
            profile.avgScore = Math.max(0, Math.min(10, profile.avgScore + adj.delta));
        }
    }
    // 4. Find similar past runs for history boosting
    const pastRuns = findSimilarPastRuns(task, memory);
    // 5. Score each model for this task
    const candidates = modelProfiles.map(profile => {
        const { score, reason } = scoreModelForTask(profile, taskProfile, mode);
        return {
            key: profile.key,
            model: profile.model,
            provider: profile.provider,
            score,
            reason,
            historyBoost: 0,
            boostedByPastRun: false,
        };
    });
    // 6. Apply history boost
    const boostedCandidates = applyHistoryBoost(candidates, pastRuns);
    // 7. Sort by score descending
    boostedCandidates.sort((a, b) => b.score - a.score);
    // 8. Build reasoning string
    const top = boostedCandidates[0];
    let reasoning = `${taskProfile.taskType} task (complexity ${taskProfile.complexity}/10) → "${top.key}" ` +
        `(${top.provider}) with score ${(top.score * 100).toFixed(0)}/100`;
    if (top.boostedByPastRun) {
        reasoning += ` · boosted by similar past run`;
    }
    if (top.reason !== 'general purpose') {
        reasoning += ` · ${top.reason}`;
    }
    return {
        model: top.model,
        provider: top.provider,
        reasoning,
        taskProfile,
        candidates: boostedCandidates,
        fallbackDecision,
    };
}
/**
 * Build ModelProfile objects from available model configs + historical performance.
 */
function buildModelProfiles(modelConfigs, memory) {
    const history = memory?.getHistory() ?? [];
    return Object.entries(modelConfigs).map(([key, config]) => {
        // Gather all results for this model key across history.
        // r.modelKey is the config key (e.g. "balanced"), r.model is the actual model name.
        const modelResults = history.filter(r => r.modelKey === key);
        const scores = modelResults.map(r => r.score).filter((s) => s !== null);
        const latencies = modelResults.map(r => r.latencyMs).filter(ms => ms > 0);
        const costs = modelResults.map(r => r.costUsd);
        const avgScore = scores.length > 0
            ? scores.reduce((a, b) => a + b, 0) / scores.length
            : 5; // neutral default
        const avgLatencyMs = latencies.length > 0
            ? latencies.reduce((a, b) => a + b, 0) / latencies.length
            : null;
        const avgCostUsd = costs.length > 0
            ? costs.reduce((a, b) => a + b, 0) / costs.length
            : null;
        // Infer strengths/weaknesses from task-type distribution of scores
        const taskTypeScores = new Map();
        const taskTypeMap = new Map();
        // Build task-type → score mapping from run reports
        if (memory) {
            const runSummaries = memory.getRunSummaries();
            for (const run of runSummaries) {
                const questionMatch = run.report.match(/Question:\s*(.+?)(?:\n|$)/i);
                if (!questionMatch)
                    continue;
                const question = questionMatch[1].trim();
                const taskType = inferTaskType(question);
                const goalResults = history.filter(r => r.goalId === run.goalId && r.modelKey === key && r.score !== null);
                for (const r of goalResults) {
                    (taskTypeScores.get(taskType) ?? []).push(r.score ?? 0);
                }
            }
        }
        const strengths = [];
        const weaknesses = [];
        const avgOverall = scores.length > 0
            ? scores.reduce((a, b) => a + b, 0) / scores.length
            : 5;
        for (const [tt, ttScores] of taskTypeScores) {
            if (ttScores.length < 2)
                continue;
            const ttAvg = ttScores.reduce((a, b) => a + b, 0) / ttScores.length;
            if (ttAvg >= avgOverall + 1)
                strengths.push(tt);
            if (ttAvg <= avgOverall - 1.5)
                weaknesses.push(tt);
        }
        // If no history, use keyword-based heuristics as fallback
        if (scores.length === 0) {
            const inferredType = inferTaskType(key);
            if (inferredType !== 'general') {
                strengths.push(inferredType);
            }
        }
        return {
            key,
            provider: config.provider,
            model: config.model,
            avgScore,
            avgLatencyMs,
            avgCostUsd,
            strengths,
            weaknesses,
            sampleSize: modelResults.length,
        };
    });
}
// ── CLI helpers ───────────────────────────────────────────────────────────────
/**
 * Pretty-print a routing decision for CLI output.
 */
export function formatRoutingDecisionV2(decision) {
    const lines = [];
    lines.push(`\n🎯 Learned Routing (v2)`);
    lines.push(`   Task type: ${decision.taskProfile.taskType} | Complexity: ${decision.taskProfile.complexity}/10`);
    if (decision.taskProfile.latencyPriority)
        lines.push(`   Mode: latency-priority`);
    else if (decision.taskProfile.costPriority)
        lines.push(`   Mode: cost-priority`);
    else
        lines.push(`   Mode: quality`);
    lines.push(``);
    lines.push(`   → ${decision.model} (${decision.provider})`);
    lines.push(`   ${decision.reasoning}`);
    lines.push(``);
    lines.push(`   📊 Candidate ranking:`);
    for (let i = 0; i < Math.min(decision.candidates.length, 5); i++) {
        const c = decision.candidates[i];
        const bar = '█'.repeat(Math.round(c.score * 10)) + '░'.repeat(10 - Math.round(c.score * 10));
        const boost = c.boostedByPastRun ? ' ⬆' : '';
        lines.push(`   ${i + 1}. [${bar}] ${c.key} (${c.model}) — ${c.reason}${boost}`);
    }
    if (decision.fallbackDecision) {
        lines.push(``);
        lines.push(`   🔄 Keyword router would have chosen:`);
        lines.push(`      ${decision.fallbackDecision.model} (${decision.fallbackDecision.provider})`);
        lines.push(`      ${decision.fallbackDecision.reasoning}`);
    }
    return lines.join('\n');
}
/**
 * Format a model profile for CLI display.
 */
export function formatModelProfile(profile) {
    const lines = [];
    lines.push(`\n📋 Model Profile: ${profile.key}`);
    lines.push(`   Model: ${profile.model} (${profile.provider})`);
    lines.push(`   Avg score: ${profile.avgScore.toFixed(1)}/10${profile.sampleSize > 0 ? ` (${profile.sampleSize} runs)` : ' (no data yet)'}`);
    if (profile.avgLatencyMs !== null)
        lines.push(`   Avg TTFT: ${Math.round(profile.avgLatencyMs)}ms`);
    if (profile.avgCostUsd !== null)
        lines.push(`   Avg cost: $${profile.avgCostUsd.toFixed(4)}/run`);
    if (profile.strengths.length > 0)
        lines.push(`   Strengths: ${profile.strengths.join(', ')}`);
    if (profile.weaknesses.length > 0)
        lines.push(`   Weaknesses: ${profile.weaknesses.join(', ')}`);
    return lines.join('\n');
}
//# sourceMappingURL=routing_v2.js.map