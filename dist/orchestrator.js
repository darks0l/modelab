import { calcCost } from './router.js';
import { callModelFull } from './evaluator.js';
import { scoreOutput } from './scorer.js';
import { ExperimentMemory } from './memory.js';
import { Cache } from './cache.js';
const SPINNERS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIdx = 0;
function spin(label) {
    const s = SPINNERS[spinnerIdx++ % SPINNERS.length];
    return `\r${s} ${label}`;
}
function uuid() {
    return crypto.randomUUID();
}
export class ResearchOrchestrator {
    models;
    budget;
    evalModelKey;
    parallelism;
    memory;
    cache;
    onStream;
    onArmComplete;
    onProgress;
    constructor(config) {
        this.models = config.models;
        this.budget = config.budget;
        this.evalModelKey = config.evalModel;
        this.parallelism = config.parallelism;
        this.memory = config.memory ?? new ExperimentMemory();
        this.cache = config.cache;
        this.onStream = config.onStream;
        this.onArmComplete = config.onArmComplete;
        this.onProgress = config.onProgress;
    }
    async run(goal) {
        const runId = uuid();
        const startTime = Date.now();
        let totalCostUsd = 0;
        const allResults = [];
        let bestResult;
        let status = 'running';
        this.progress(`Starting run ${runId.slice(0, 8)} — "${goal.question.slice(0, 60)}${goal.question.length > 60 ? '...' : ''}"`);
        this.progress(`Threshold: ${goal.qualityThreshold} | Arms: ${goal.arms.length} | Max iterations: ${goal.maxIterations}`);
        // Expand temperature-sweep arms into per-temperature sub-arms
        const expandedArms = goal.arms.flatMap(arm => {
            if (arm.temperatureSweep && arm.temperatureSweep.length > 0) {
                return arm.temperatureSweep.map(temp => ({
                    ...arm,
                    id: `${arm.id}_t${temp}`.replace('.', '_'),
                    name: `${arm.name} (T=${temp})`,
                    temperature: temp,
                    temperatureSweep: undefined, // expanded, no longer needed
                }));
            }
            return [arm];
        });
        try {
            for (let iter = 1; iter <= goal.maxIterations; iter++) {
                // Cross-iteration learning: pull context ONCE per iteration (not per-arm)
                const iterContext = this.memory.getContextForIteration(goal.id, runId, iter);
                if (iterContext.contextString) {
                    this.progress(`\n📚 Prior context loaded (${iterContext.priorIterations.length} prior iteration${iterContext.priorIterations.length !== 1 ? 's' : ''}, best so far: ${iterContext.bestScoreSoFar !== null ? iterContext.bestScoreSoFar + '/10' : 'N/A'})`);
                }
                this.progress(`\n── Iteration ${iter}/${goal.maxIterations} (${expandedArms.length} arms after expansion) ──`);
                if (this.budget.maxPerRun > 0 && totalCostUsd >= this.budget.maxPerRun) {
                    this.progress('Budget exceeded — stopping');
                    status = 'budget_exceeded';
                    break;
                }
                // Batch arms by parallelism
                const batches = batchArray(expandedArms, this.parallelism);
                for (const batch of batches) {
                    // Pre-check: estimate total cost for this batch before spending anything
                    const batchCostEstimate = batch.reduce((sum, arm) => {
                        const cfg = this.models[arm.model];
                        if (!cfg)
                            return sum;
                        // Rough estimate: 1000 input + 500 output tokens at model's rate
                        return sum + calcCost(1000, 500, cfg);
                    }, 0);
                    if (this.budget.maxPerRun > 0 && totalCostUsd + batchCostEstimate > this.budget.maxPerRun) {
                        this.progress(`Budget would exceed limit ($${totalCostUsd.toFixed(4)} + ~$${batchCostEstimate.toFixed(4)} > $${this.budget.maxPerRun}) — stopping`);
                        status = 'budget_exceeded';
                        break;
                    }
                    const armResults = await Promise.allSettled(batch.map(arm => this.runArm(arm, goal, iter, runId, iterContext)));
                    for (const result of armResults) {
                        if (result.status === 'rejected') {
                            console.error(`  ❌ ${result.reason}`);
                            continue;
                        }
                        const r = result.value;
                        allResults.push(r);
                        totalCostUsd += r.costUsd;
                        this.memory.log(r, runId, goal.id);
                        if (r.score !== null && (!bestResult || r.score > (bestResult.score ?? -1))) {
                            bestResult = r;
                        }
                        this.onArmComplete?.(r);
                    }
                }
                // Cross-iteration learning: summarize what happened this iteration
                const iterResults = allResults.filter(r => r.iteration === iter);
                if (iterResults.length > 0) {
                    const summary = this.memory.summarize(runId, goal.id, iter, iterResults);
                    this.progress(`  📝 Lesson: ${summary.lesson}`);
                }
                if (bestResult && bestResult.score !== null && bestResult.score >= goal.qualityThreshold) {
                    this.progress(`\n✅ Quality threshold reached: ${bestResult.score} ≥ ${goal.qualityThreshold}`);
                    status = 'quality_reached';
                    break;
                }
            }
            if (status === 'running')
                status = 'completed';
        }
        catch (err) {
            console.error(`\n❌ Run failed:`, err);
            status = 'failed';
        }
        const completedAt = new Date().toISOString();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        this.progress(`\n🏁 Run complete | ${status} | $${totalCostUsd.toFixed(4)} | ${elapsed}s`);
        // Print comparison table
        if (allResults.length > 1) {
            this.printComparisonTable(allResults);
        }
        // Store run-level summary so the full experiment story is preserved
        const startedAtIso = new Date(startTime).toISOString();
        this.memory.summarizeRun(runId, goal.id, status, startedAtIso, completedAt, allResults);
        return {
            goalId: goal.id,
            runId,
            status,
            startedAt: startedAtIso,
            completedAt,
            totalCostUsd: Math.round(totalCostUsd * 1e6) / 1e6,
            bestResult,
            allResults,
        };
    }
    async runArm(arm, goal, iteration, runId, iterContext) {
        const startMs = Date.now();
        let latencyMs = 0; // Time-to-first-token (TTFT)
        const modelConfig = this.models[arm.model];
        if (!modelConfig) {
            throw new Error(`Unknown model: "${arm.model}". Available: ${Object.keys(this.models).join(', ')}`);
        }
        // Check cache
        if (this.cache) {
            const cached = this.cache.lookup(goal.question, arm.model, arm.id);
            if (cached) {
                this.progress(`  🗃️  ${arm.name}: cache hit — score ${cached.score}`);
                return {
                    ...cached,
                    iteration,
                    cached: true,
                    runId,
                    goalId: goal.id,
                    model: arm.model,
                    durationMs: cached.durationMs ?? 0,
                    latencyMs: 0,
                };
            }
        }
        // Build prompt: if template lacks {{iteration_context}}, auto-prepend it so prior
        // learnings are NEVER silently dropped — this is the cross-iteration memory fix.
        let effectiveTemplate = arm.promptTemplate;
        if (iterContext.contextString && !arm.promptTemplate.includes('{{iteration_context}}')) {
            effectiveTemplate =
                `## Prior Research Context\n${iterContext.contextString}\n\n` +
                    `## Your Task\n${arm.promptTemplate}`;
        }
        const variables = {
            ...arm.variables,
            question: goal.question,
            goal: goal.goal,
            iteration_context: iterContext.contextString,
        };
        const prompt = fillTemplate(effectiveTemplate, variables);
        // Stream callback — tracks time-to-first-token
        let streamedOutput = '';
        let firstTokenMs = null;
        const streamCb = this.onStream
            ? (chunk) => {
                if (firstTokenMs === null)
                    firstTokenMs = Date.now() - startMs;
                streamedOutput += chunk;
                this.onStream(arm.name, chunk);
            }
            : undefined;
        let output;
        let inputTokens = 0;
        let outputTokens = 0;
        try {
            // Arm-level temperature overrides model default
            const configWithStream = arm.temperature !== undefined
                ? { ...modelConfig, temperature: arm.temperature, stream: streamCb }
                : { ...modelConfig, stream: streamCb };
            const result = await callModelFull(configWithStream, prompt);
            output = result.output;
            inputTokens = result.inputTokens;
            outputTokens = result.outputTokens;
            // For streaming calls, TTFT was captured in the stream callback
            // For non-streaming, estimate TTFT as 10% of total duration (rough proxy)
            const elapsed = Date.now() - startMs;
            latencyMs = firstTokenMs ?? Math.round(elapsed * 0.1);
        }
        catch (err) {
            throw new Error(`Arm "${arm.name}" failed: ${err}`);
        }
        const costUsd = calcCost(inputTokens, outputTokens, modelConfig);
        if (this.budget.maxPerExperiment > 0 && costUsd > this.budget.maxPerExperiment) {
            throw new Error(`Arm "${arm.name}": cost $${costUsd.toFixed(4)} exceeds per-experiment cap`);
        }
        // Score — always use JSON mode for deterministic structured output
        let score = null;
        let scoreError = null;
        const evalConfig = this.models[this.evalModelKey];
        if (evalConfig) {
            const scoreResult = await scoreOutput(output, goal.question, { ...evalConfig, jsonMode: true });
            score = scoreResult.score;
            scoreError = scoreResult.error ?? null;
        }
        const result = {
            armId: arm.id,
            model: arm.model,
            output,
            score,
            scoreError,
            costUsd: Math.round(costUsd * 1e6) / 1e6,
            tokensUsed: { input: inputTokens, output: outputTokens },
            durationMs: Date.now() - startMs,
            latencyMs,
            timestamp: new Date().toISOString(),
            iteration,
            cached: false,
            runId,
            goalId: goal.id,
        };
        // Cache the result
        if (this.cache && !result.cached) {
            const key = Cache.hash(goal.question, arm.model, arm.id);
            this.cache.set(key, result, goal.question, arm.model);
        }
        const scoreStr = score !== null ? `${score}/10` : 'N/A';
        const cachedStr = result.cached ? ' 🗃️' : '';
        const latencyStr = result.latencyMs > 0 ? ` | TTFT: ${result.latencyMs}ms` : '';
        this.progress(`  ${result.cached ? '🗃️' : '✅'} ${arm.name}: ${scoreStr}${cachedStr} | $${result.costUsd.toFixed(4)} | ${inputTokens + outputTokens} tokens | ${(result.durationMs / 1000).toFixed(1)}s${latencyStr}`);
        return result;
    }
    printComparisonTable(results) {
        const sorted = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const maxOutputLen = 80;
        console.log('\n┌' + '─'.repeat(78) + '┐');
        console.log('│' + ' RESULTS COMPARISON '.padStart(40).padEnd(78) + '│');
        console.log('├' + '─'.repeat(78) + '┤');
        for (const r of sorted) {
            const scoreStr = r.score !== null ? `⭐ ${r.score.toFixed(1)}/10` : '  —  ';
            const cachedStr = r.cached ? ' [cached]' : '';
            const latencyStr = r.latencyMs > 0 ? ` | TTFT:${r.latencyMs}ms` : '';
            const header = ` ${r.armId}${cachedStr} ${scoreStr} $${r.costUsd.toFixed(4)}${latencyStr} | ${(r.durationMs / 1000).toFixed(1)}s`;
            const truncated = r.output.length > maxOutputLen ? r.output.slice(0, maxOutputLen) + '...' : r.output;
            console.log('│' + header.padEnd(78) + '│');
            // Word-wrap the output
            const wrapped = wordWrap(truncated, 76);
            for (const line of wrapped.slice(0, 4)) {
                console.log('│  ' + line.padEnd(76) + '│');
            }
            console.log('├' + '─'.repeat(78) + '┤');
        }
        // Latency stats footer
        const latencies = results.map(r => r.latencyMs).filter(ms => ms > 0);
        if (latencies.length > 0) {
            const sorted = [...latencies].sort((a, b) => a - b);
            const n = sorted.length;
            const avgMs = Math.round(sorted.reduce((s, v) => s + v, 0) / n);
            const p50Ms = sorted[Math.floor(n * 0.50)];
            const p95Ms = sorted[Math.floor(n * 0.95)];
            console.log('│' + ' TTFT latency  avg:' + String(avgMs).padStart(5) + 'ms  p50:' + String(p50Ms).padStart(5) + 'ms  p95:' + String(p95Ms).padStart(5) + 'ms'.padEnd(70) + '│');
        }
        console.log('└' + '─'.repeat(78) + '┘');
    }
    progress(msg) {
        if (this.onProgress) {
            this.onProgress(msg);
        }
        else {
            console.log(msg);
        }
    }
}
function batchArray(arr, size) {
    const batches = [];
    for (let i = 0; i < arr.length; i += size)
        batches.push(arr.slice(i, i + size));
    return batches;
}
function fillTemplate(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}
function wordWrap(text, width) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
        if ((line + ' ' + word).trim().length > width) {
            if (line)
                lines.push(line.trim());
            line = word;
        }
        else {
            line = (line + ' ' + word).trim();
        }
    }
    if (line)
        lines.push(line.trim());
    return lines;
}
//# sourceMappingURL=orchestrator.js.map