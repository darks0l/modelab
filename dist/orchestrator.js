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
        try {
            for (let iter = 1; iter <= goal.maxIterations; iter++) {
                this.progress(`\n── Iteration ${iter}/${goal.maxIterations} ──`);
                if (this.budget.maxPerRun > 0 && totalCostUsd >= this.budget.maxPerRun) {
                    this.progress('Budget exceeded — stopping');
                    status = 'budget_exceeded';
                    break;
                }
                // Batch arms by parallelism
                const batches = batchArray(goal.arms, this.parallelism);
                for (const batch of batches) {
                    if (this.budget.maxPerRun > 0 && totalCostUsd >= this.budget.maxPerRun) {
                        status = 'budget_exceeded';
                        break;
                    }
                    const armResults = await Promise.allSettled(batch.map(arm => this.runArm(arm, goal, iter, runId)));
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
        return {
            goalId: goal.id,
            runId,
            status,
            startedAt: new Date(startTime).toISOString(),
            completedAt,
            totalCostUsd: Math.round(totalCostUsd * 1e6) / 1e6,
            bestResult,
            allResults,
        };
    }
    async runArm(arm, goal, iteration, runId) {
        const startMs = Date.now();
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
                    durationMs: cached.durationMs ?? 0,
                };
            }
        }
        // Fill template
        const variables = { ...arm.variables, question: goal.question, goal: goal.goal };
        const prompt = fillTemplate(arm.promptTemplate, variables);
        // Stream callback
        let streamedOutput = '';
        const streamCb = this.onStream
            ? (chunk) => {
                streamedOutput += chunk;
                this.onStream(arm.name, chunk);
            }
            : undefined;
        let output;
        let inputTokens = 0;
        let outputTokens = 0;
        try {
            const configWithStream = { ...modelConfig, stream: streamCb };
            const result = await callModelFull(configWithStream, prompt);
            output = result.output;
            inputTokens = result.inputTokens;
            outputTokens = result.outputTokens;
        }
        catch (err) {
            throw new Error(`Arm "${arm.name}" failed: ${err}`);
        }
        const costUsd = calcCost(inputTokens, outputTokens, modelConfig);
        if (this.budget.maxPerExperiment > 0 && costUsd > this.budget.maxPerExperiment) {
            throw new Error(`Arm "${arm.name}": cost $${costUsd.toFixed(4)} exceeds per-experiment cap`);
        }
        // Score
        let score = null;
        const evalConfig = this.models[this.evalModelKey];
        if (evalConfig) {
            const scoreResult = await scoreOutput(output, goal.question, evalConfig);
            score = scoreResult.score;
        }
        const result = {
            armId: arm.id,
            output,
            score,
            costUsd: Math.round(costUsd * 1e6) / 1e6,
            tokensUsed: { input: inputTokens, output: outputTokens },
            durationMs: Date.now() - startMs,
            timestamp: new Date().toISOString(),
            iteration,
            cached: false,
            runId,
            goalId: goal.id,
        };
        // Cache the result
        if (this.cache && !result.cached) {
            const key = Cache.hash(goal.question, arm.model, arm.id);
            this.cache.set(key, result, goal.question);
        }
        const scoreStr = score !== null ? `${score}/10` : 'N/A';
        const cachedStr = result.cached ? ' 🗃️' : '';
        this.progress(`  ${result.cached ? '🗃️' : '✅'} ${arm.name}: ${scoreStr}${cachedStr} | $${result.costUsd.toFixed(4)} | ${inputTokens + outputTokens} tokens | ${(result.durationMs / 1000).toFixed(1)}s`);
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
            const header = ` ${r.armId}${cachedStr} ${scoreStr} $${r.costUsd.toFixed(4)}`;
            const truncated = r.output.length > maxOutputLen ? r.output.slice(0, maxOutputLen) + '...' : r.output;
            console.log('│' + header.padEnd(78) + '│');
            // Word-wrap the output
            const wrapped = wordWrap(truncated, 76);
            for (const line of wrapped.slice(0, 4)) {
                console.log('│  ' + line.padEnd(76) + '│');
            }
            console.log('├' + '─'.repeat(78) + '┤');
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