#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { z } from 'zod';
import { ResearchOrchestrator } from './orchestrator.js';
import { ExperimentMemory } from './memory.js';
import { Cache } from './cache.js';
import { routeTask } from './router.js';
import { getTemplate, listTemplates } from './templates.js';
import { exportRun } from './export.js';
const CONFIG_PATH = join(homedir(), '.modelab', 'config.json');
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
// ── Config Schema ──────────────────────────────────────────────────────────
const ModelProviderEnum = z.enum(['openai', 'anthropic', 'ollama', 'openrouter', 'minimax', 'groq', 'gemini', 'perplexity', 'glm']);
const ModelConfigSchema = z.object({
    provider: ModelProviderEnum,
    model: z.string(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    costPerMillionInput: z.number().optional().default(0),
    costPerMillionOutput: z.number().optional().default(0),
});
const ConfigSchema = z.object({
    models: z.record(ModelConfigSchema),
    budget: z.object({
        maxPerRun: z.number().default(2.0),
        maxPerExperiment: z.number().default(0.5),
        trackCosts: z.boolean().default(true),
    }),
    evalModel: z.string().default('balanced'),
    parallelism: z.number().default(3),
});
function loadConfig() {
    if (!existsSync(CONFIG_PATH)) {
        console.error(`Config not found at ${CONFIG_PATH}`);
        console.error('Run: modelab config --init');
        process.exit(1);
    }
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    const parsed = ConfigSchema.parse(raw);
    // Add defaults for missing fields
    for (const [key, model] of Object.entries(parsed.models)) {
        model.costPerMillionInput ??= 0;
        model.costPerMillionOutput ??= 0;
    }
    return parsed;
}
// ── Default config ──────────────────────────────────────────────────────────
function defaultConfig() {
    return {
        models: {
            fast: { provider: 'openai', model: 'gpt-4o-mini', costPerMillionInput: 0.15, costPerMillionOutput: 0.60 },
            balanced: { provider: 'anthropic', model: 'claude-sonnet-4-6', costPerMillionInput: 3, costPerMillionOutput: 15 },
            reasoning: { provider: 'openai', model: 'o1', costPerMillionInput: 15, costPerMillionOutput: 60 },
            coding: { provider: 'ollama', model: 'qwen3-coder', baseUrl: 'http://localhost:11434', costPerMillionInput: 0, costPerMillionOutput: 0 },
            groq: { provider: 'groq', model: 'llama-3.3-70b-versatile', costPerMillionInput: 0, costPerMillionOutput: 0 },
            gemini: { provider: 'gemini', model: 'gemini-2.0-flash', costPerMillionInput: 0, costPerMillionOutput: 0 },
            glm: { provider: 'glm', model: 'glm-4.7', costPerMillionInput: 0.1, costPerMillionOutput: 0.1 },
            glm5: { provider: 'glm', model: 'glm-5-flash', costPerMillionInput: 0.1, costPerMillionOutput: 0.1 },
            glm51: { provider: 'glm', model: 'glm-5.1-flash', costPerMillionInput: 0.1, costPerMillionOutput: 0.1 },
        },
        budget: { maxPerRun: 2.0, maxPerExperiment: 0.5, trackCosts: true },
        evalModel: 'balanced',
        parallelism: 3,
    };
}
// ── Help ────────────────────────────────────────────────────────────────────
function printHelp() {
    console.log(`
🌑 modelab — AI research OS

USAGE
  modelab run --goal <text> [options]     Run a research experiment
  modelab interactive                      Launch interactive TUI menu
  modelab history                         Show experiment history
  modelab best [--goal-id <id>]           Show best result
  modelab templates                        List built-in prompt templates
  modelab export <run-id> --format md     Export a past run
  modelab config --init                   Create default config
  modelab config --list                   Show current config
  modelab cache --clear                   Clear the result cache
  modelab route --task <text> [--mode quality|latency|cost]  Show model routing decision
  modelab lessons [--goal-id <id>]        Show what the system learned across runs
  modelab report <run-id>                 Show full run report with lessons + latency
  modelab --help                          Show this help

RUN OPTIONS
  --goal <text>           Research question (required)
  --iterations N          Max iterations (default: 3)
  --threshold N           Quality threshold 0-10 (default: 7.0)
  --arms <model1,model2>  Comma-separated model keys to use (default: first 2 models)
  --template <id>         Use a built-in template (see: modelab templates)
  --format json|md|html   Export format (default: md)
  --output <path>         Write output to file
  --no-cache              Disable result caching
  --stream                Show tokens as they arrive
  --temperature <n>       Set temperature for all arms (0.0–2.0)
  --temperature-sweep <v> Comma-separated temperatures to sweep across (e.g. 0,0.3,0.7,1.0)
                           Each model arm expands into one arm per temperature value

ROUTING MODES
  modelab route --task <text> --mode latency
                           Route for minimum latency (uses 'fast' model)
  modelab route --task <text> --mode cost
                           Route for minimum cost

EXAMPLES
  modelab run --goal "What causes migraines?" --threshold 8
  modelab run --goal "Review my API design" --template code-review --arms balanced,coding
  modelab run --goal "Compare Postgres vs DynamoDB" --template compare --arms balanced,reasoning
  modelab run --goal "Write a short poem" --temperature-sweep 0,0.3,0.7,1.0 --arms balanced
  modelab export run-abc123 --format html --output report.html

ENVIRONMENT
  OPENAI_API_KEY        OpenAI / Groq / OpenRouter models
  ANTHROPIC_API_KEY     Anthropic models
  MINIMAX_API_KEY       MiniMax models
  GROQ_API_KEY          Groq models (free fast inference)
  GEMINI_API_KEY        Google Gemini models
  PERPLEXITY_API_KEY    Perplexity models
  GLM_API_KEY          Zhipu GLM models (glm, glm5)
`.trim());
}
// ── Commands ────────────────────────────────────────────────────────────────
async function cmdLessons(args) {
    const memory = new ExperimentMemory();
    const goalId = extractArg(args, '--goal-id');
    const lessons = memory.getLessons(goalId ?? undefined);
    if (lessons.length === 0) {
        console.log('No lessons yet. Run some experiments first: modelab run --goal "..."');
        memory.close();
        return;
    }
    console.log('\n📚 Cross-iteration lessons\n');
    console.log(`${'─'.repeat(60)}`);
    let lastGoal = '';
    for (const l of lessons) {
        if (l.goalId !== lastGoal) {
            console.log(`\nGoal: ${l.goalId}`);
            lastGoal = l.goalId;
        }
        const scoreStr = l.bestScore !== null ? ` ⭐${l.bestScore}/10` : '';
        console.log(`  Iteration ${l.iteration}${scoreStr}: ${l.lesson}`);
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Total lessons: ${lessons.length}`);
    memory.close();
}
/**
 * Interactive TUI menu — keyboard-navigable.
 * Presents: history browser, best results, lessons, quick-run.
 */
async function cmdInteractive() {
    const memory = new ExperimentMemory();
    const mainMenu = [
        { id: 'history', label: '📜 Browse history', sublabel: 'Navigate past runs' },
        { id: 'best', label: '🏆 View best results', sublabel: 'See top-scoring runs' },
        { id: 'lessons', label: '📚 Cross-iteration lessons', sublabel: 'What the system learned' },
        { id: 'quick', label: '⚡ Quick research run', sublabel: 'Jump straight into a research run' },
        { id: 'quit', label: '🚪 Quit' },
    ];
    const selected = await interactiveSelect('\n\x1b[36m\x1b[1m🌑 modelab — Interactive Menu\x1b[0m\n', mainMenu, (item) => `${item.label}  \x1b[2m${item.sublabel ?? ''}\x1b[0m`);
    if (selected === 'quit' || selected === undefined) {
        console.log('\n👋 Goodbye from modelab.\n');
        memory.close();
        return;
    }
    if (selected === 'history') {
        await interactiveHistory(memory);
    }
    else if (selected === 'best') {
        await interactiveBest(memory);
    }
    else if (selected === 'lessons') {
        await interactiveLessons(memory);
    }
    else if (selected === 'quick') {
        await interactiveQuickRun();
    }
    memory.close();
}
async function interactiveHistory(memory) {
    const results = memory.getHistory();
    if (results.length === 0) {
        console.log('\nNo experiment history yet. Run `modelab run --goal "..."` first.\n');
        return;
    }
    // Group by runId
    const runMap = new Map();
    for (const r of results) {
        if (!runMap.has(r.runId)) {
            runMap.set(r.runId, { runId: r.runId, goalId: r.goalId, armCount: 0, bestScore: r.score, timestamp: r.timestamp, cost: 0 });
        }
        const entry = runMap.get(r.runId);
        entry.armCount++;
        entry.cost += r.costUsd;
        if (r.score !== null && (entry.bestScore === null || r.score > entry.bestScore)) {
            entry.bestScore = r.score;
        }
    }
    const runs = [...runMap.values()].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const items = runs.map(r => ({
        id: r.runId,
        label: `Run ${r.runId.slice(0, 8)}… | ⭐${r.bestScore?.toFixed(1) ?? '?'}/10 | $${r.cost.toFixed(4)} | ${r.armCount} arm${r.armCount !== 1 ? 's' : ''}`,
        sublabel: r.goalId,
    }));
    const selectedRunId = await interactiveSelect('\n\x1b[36m\x1b[1m📜 Experiment History\x1b[0m — select a run\n', items, (item) => `${item.label}  \x1b[2m${item.sublabel ?? ''}\x1b[0m`);
    if (!selectedRunId)
        return;
    const runResults = results.filter(r => r.runId === selectedRunId);
    const runItems = runResults
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .map(r => ({
        id: r.armId,
        label: `${r.armId}  \x1b[2m${r.model}\x1b[0m`,
        sublabel: `score: ${r.score ?? '?'}/10 · $${r.costUsd.toFixed(4)} · ${r.durationMs}ms`,
        detail: r.output.slice(0, 300),
    }));
    const selectedArmId = await interactiveSelect(`\n\x1b[36m\x1b[1mRun ${selectedRunId.slice(0, 8)}…\x1b[0m — select an arm to preview\n`, runItems, (item) => `${item.label}  \x1b[2m${item.sublabel ?? ''}\x1b[0m`);
    if (selectedArmId) {
        const selected = runResults.find(r => r.armId === selectedArmId);
        if (selected) {
            console.log('\n\x1b[1m' + selectedArmId + '\x1b[0m ' + (selected.score !== null ? `\x1b[33m⭐ ${selected.score}/10\x1b[0m` : ''));
            console.log(`${'─'.repeat(60)}`);
            console.log(selected.output.slice(0, 1000));
            if (selected.output.length > 1000)
                console.log(`\n… (${selected.output.length - 1000} more chars)`);
            console.log(`${'─'.repeat(60)}\n`);
        }
    }
}
async function interactiveBest(memory) {
    const results = memory.getHistory();
    if (results.length === 0) {
        console.log('\nNo results yet.\n');
        return;
    }
    // Find best per-goal
    const bestByGoal = new Map();
    for (const r of results) {
        if (r.score !== null && (!bestByGoal.has(r.goalId) || r.score > (bestByGoal.get(r.goalId).score ?? 0))) {
            bestByGoal.set(r.goalId, r);
        }
    }
    const items = [...bestByGoal.entries()].map(([goalId, r]) => ({
        id: r.runId,
        label: `\x1b[33m⭐ ${r.score}/10\x1b[0m  ${r.armId}`,
        sublabel: goalId.slice(0, 50),
        detail: r.output.slice(0, 300),
    }));
    const selected = await interactiveSelect('\n\x1b[36m\x1b[1m🏆 Best Results by Goal\x1b[0m — select to preview\n', items, (item) => `${item.label}  \x1b[2m${item.sublabel ?? ''}\x1b[0m`);
    if (selected) {
        const runResults = results.filter(r => r.runId === selected);
        const best = runResults.reduce((b, r) => r.score !== null && (!b || r.score > (b.score ?? 0)) ? r : b, runResults[0]);
        console.log('\n\x1b[1m' + best.armId + '\x1b[0m \x1b[33m⭐ ' + (best.score ?? '?') + '/10\x1b[0m');
        console.log(`${'─'.repeat(60)}`);
        console.log(best.output.slice(0, 1000));
        if (best.output.length > 1000)
            console.log(`\n… (${best.output.length - 1000} more chars)`);
        console.log(`${'─'.repeat(60)}\n`);
    }
}
async function interactiveLessons(memory) {
    const lessons = memory.getLessons();
    if (lessons.length === 0) {
        console.log('\nNo lessons yet.\n');
        return;
    }
    const items = lessons.map((l, i) => ({
        id: `${l.runId}-${l.iteration}`,
        label: `\x1b[36mIteration ${l.iteration}\x1b[0m  \x1b[33m${l.bestScore !== null ? '⭐' + l.bestScore + '/10' : ''}\x1b[0m  ${l.lesson.slice(0, 60)}…`,
        sublabel: l.goalId.slice(0, 50),
    }));
    const selected = await interactiveSelect('\n\x1b[36m\x1b[1m📚 Cross-Iteration Lessons\x1b[0m — select to see detail\n', items, (item) => item.label);
    if (selected) {
        const parts = selected.split('-');
        const runId = parts.slice(0, -1).join('-');
        const iter = parseInt(parts[parts.length - 1], 10);
        const summaries = memory.getSummaries(runId).filter(s => s.iteration === iter);
        if (summaries.length > 0) {
            const s = summaries[0];
            console.log(`\n\x1b[1mIteration ${s.iteration} Summary\x1b[0m`);
            console.log(`${'─'.repeat(60)}`);
            if (s.whatWorked)
                console.log('\n\x1b[32m✅ What worked:\x1b[0m', s.whatWorked.slice(0, 500));
            if (s.whatDidntWork)
                console.log('\n\x1b[31m❌ What didn\'t work:\x1b[0m', s.whatDidntWork.slice(0, 300));
            console.log('\n\x1b[1m💡 Lesson:\x1b[0m', s.lesson);
            console.log(`${'─'.repeat(60)}\n`);
        }
    }
}
async function interactiveQuickRun() {
    const config = loadConfig();
    const question = await readLine('\n🔍 What do you want to research? ');
    if (!question) {
        console.log('Cancelled.');
        return;
    }
    const modelKeys = Object.keys(config.models);
    const modelItems = modelKeys.map(key => ({
        id: key,
        label: `${key.padEnd(12)} ${config.models[key].provider.padEnd(12)} ${config.models[key].model}`,
        sublabel: `$${config.models[key].costPerMillionInput}/1M in · $${config.models[key].costPerMillionOutput}/1M out`,
    }));
    const selected = await interactiveSelect('\n\x1b[36m\x1b[1m⚡ Select a Model\x1b[0m\n', modelItems, (item) => `${item.label}  \x1b[2m${item.sublabel ?? ''}\x1b[0m`);
    if (!selected)
        return;
    // Build a single-arm run
    const goal = {
        id: `quick-${Date.now()}`,
        question,
        goal: question,
        qualityThreshold: 7,
        maxIterations: 1,
        arms: [{
                id: `${selected}-quick`,
                name: `${selected} (${config.models[selected].provider})`,
                promptTemplate: `You are a research assistant.\n\nGoal: {{goal}}\nQuestion: {{question}}\n\nProvide a thorough, well-reasoned response.`,
                model: selected,
            }],
    };
    const memory = new ExperimentMemory();
    const orchestrator = new ResearchOrchestrator({
        models: config.models,
        budget: config.budget,
        evalModel: config.evalModel,
        parallelism: 1,
        memory,
    });
    console.log(`\n⚡ Running quick research with ${selected}…\n`);
    const log = await orchestrator.run(goal);
    if (log.bestResult) {
        console.log(`\n${'─'.repeat(60)}`);
        console.log(log.bestResult.output.slice(0, 1000));
        if (log.bestResult.output.length > 1000)
            console.log(`\n… (${log.bestResult.output.length - 1000} more chars)`);
        console.log(`${'─'.repeat(60)}\n`);
        console.log(`\x1b[33m⭐ Score: ${log.bestResult.score}/10\x1b[0m · $${log.bestResult.costUsd.toFixed(4)} · ${log.bestResult.durationMs}ms`);
    }
    memory.close();
}
async function cmdRun(args) {
    const config = loadConfig();
    const memory = new ExperimentMemory();
    const cache = !args.includes('--no-cache') ? new Cache(CACHE_TTL) : undefined;
    // Parse args
    const goalText = extractArg(args, '--goal') ?? '';
    const maxIterations = parseInt(extractArg(args, '--iterations') ?? '3', 10);
    const qualityThreshold = parseFloat(extractArg(args, '--threshold') ?? '7.0');
    const templateId = extractArg(args, '--template');
    const format = (extractArg(args, '--format') ?? 'md');
    const outputPath = extractArg(args, '--output');
    const useStream = args.includes('--stream');
    if (!goalText) {
        console.error('❌ --goal is required');
        process.exit(1);
    }
    // Build arms
    const armModels = extractArg(args, '--arms')?.split(',').map(s => s.trim()) ?? Object.keys(config.models).slice(0, 2);
    const invalidModels = armModels.filter(m => !config.models[m]);
    if (invalidModels.length > 0) {
        console.error(`❌ Unknown models: ${invalidModels.join(', ')}. Available: ${Object.keys(config.models).join(', ')}`);
        process.exit(1);
    }
    // Temperature sweep: --temperature-sweep 0,0.3,0.7,1.0 expands each arm into multiple temp variants
    const tempSweepRaw = extractArg(args, '--temperature-sweep');
    const temperatureSweep = tempSweepRaw
        ? tempSweepRaw.split(',').map(s => { const v = parseFloat(s.trim()); if (isNaN(v) || v < 0 || v > 2) {
            console.error(`❌ Invalid temperature value: ${s.trim()}`);
            process.exit(1);
        } return v; })
        : [];
    // Single temperature override (applies to all arms if no sweep)
    const temperatureRaw = extractArg(args, '--temperature');
    const temperature = temperatureRaw ? parseFloat(temperatureRaw) : undefined;
    // Get template
    let promptTemplate = `You are a research agent.

Goal: {{goal}}
Question: {{question}}

Provide a thorough, well-reasoned, and comprehensive response.`;
    let templateName = 'default';
    if (templateId) {
        const tmpl = getTemplate(templateId);
        if (!tmpl) {
            console.error(`❌ Unknown template: "${templateId}". Run: modelab templates`);
            process.exit(1);
        }
        promptTemplate = tmpl.promptTemplate;
        templateName = tmpl.name;
    }
    const goalId = `goal-${Date.now()}`;
    // Build arms — optionally expanded with temperature sweep
    let arms;
    if (temperatureSweep.length > 0) {
        arms = [];
        for (const model of armModels) {
            for (const temp of temperatureSweep) {
                const tempStr = temp.toFixed(1).replace(/\.0$/, '');
                arms.push({
                    id: `${model}-t${tempStr}-arm`,
                    name: `${model} (${config.models[model].provider}, temp=${tempStr})`,
                    promptTemplate,
                    model,
                    temperature: temp,
                });
            }
        }
        console.log(`\n🌑 modelab — ${templateName} mode`);
        console.log(`   Question: ${goalText}`);
        console.log(`   Temperature sweep: [${temperatureSweep.map(t => t.toFixed(1)).join(', ')}]`);
        console.log(`   Models: ${armModels.join(', ')}`);
        console.log(`   Total arms: ${arms.length} (${armModels.length} models × ${temperatureSweep.length} temperatures)`);
        console.log(`   Threshold: ${qualityThreshold}/10 | Iterations: ${maxIterations}\n`);
    }
    else {
        arms = armModels.map((model, i) => ({
            id: `${model}-arm-${i + 1}`,
            name: `${model} (${config.models[model].provider})${temperature !== undefined ? `, temp=${temperature}` : ''}`,
            promptTemplate,
            model,
            ...(temperature !== undefined ? { temperature } : {}),
        }));
        console.log(`\n🌑 modelab — ${templateName} mode`);
        console.log(`   Question: ${goalText}`);
        console.log(`   Models: ${armModels.join(', ')}${temperature !== undefined ? ` @ temp=${temperature}` : ''}`);
        console.log(`   Threshold: ${qualityThreshold}/10 | Iterations: ${maxIterations}\n`);
    }
    const goal = {
        id: goalId,
        question: goalText,
        goal: goalText,
        qualityThreshold,
        maxIterations,
        arms,
    };
    // Streaming state
    const activeStreams = new Map();
    const orchestrator = new ResearchOrchestrator({
        models: config.models,
        budget: config.budget,
        evalModel: config.evalModel,
        parallelism: config.parallelism,
        memory,
        cache,
        onStream: useStream
            ? (armName, chunk) => {
                const current = activeStreams.get(armName) ?? '';
                const updated = current + chunk;
                activeStreams.set(armName, updated);
                // Print on newlines for cleaner output
                if (chunk.includes('\n')) {
                    process.stdout.write(`\r${' '.repeat(60)}\r`);
                    console.log(`  │ ${armName}: ${updated.slice(-200)}`);
                }
            }
            : undefined,
        onProgress: (msg) => {
            if (!useStream || !msg.startsWith('  🗃️') && !msg.startsWith('  ✅')) {
                console.log(msg);
            }
        },
    });
    const log = await orchestrator.run(goal);
    // Print best result
    if (log.bestResult) {
        console.log(`\n🏆 Best result: ${log.bestResult.armId} — score ${log.bestResult.score}/10`);
        console.log(`\n${'─'.repeat(60)}`);
        console.log(log.bestResult.output.slice(0, 800));
        if (log.bestResult.output.length > 800)
            console.log(`\n... (${log.bestResult.output.length - 800} more chars)`);
        console.log(`${'─'.repeat(60)}\n`);
    }
    // Export
    if (format) {
        const content = exportRun(log, {
            format,
            includeScores: true,
            includeCost: true,
            includeMetadata: true,
        });
        if (outputPath) {
            writeFileSync(outputPath, content);
            console.log(`📄 Exported to ${outputPath}`);
        }
    }
    console.log(`💰 Total cost: $${log.totalCostUsd.toFixed(4)}`);
    console.log(`🆔 Run ID: ${log.runId}`);
    memory.close();
}
async function cmdHistory(args) {
    const memory = new ExperimentMemory();
    const goalId = extractArg(args, '--goal-id');
    const results = memory.getHistory(goalId ?? undefined);
    if (results.length === 0) {
        console.log('No experiments found. Run: modelab run --goal "..."');
    }
    else {
        console.log(`\n📜 History (${Math.min(results.length, 20)} most recent)\n`);
        const seen = new Set();
        for (const r of results.slice(0, 20)) {
            if (seen.has(r.runId))
                continue;
            seen.add(r.runId);
            const time = new Date(r.timestamp).toLocaleString();
            const scoreStr = r.score !== null ? `⭐ ${r.score}/10` : '—';
            console.log(`  [${time}] ${r.goalId.slice(0, 20)} | ${r.armId} | ${scoreStr} | $${r.costUsd.toFixed(4)}`);
        }
        console.log(`\n  Total experiments: ${results.length}`);
        console.log(`  Total spend: $${results.reduce((s, r) => s + r.costUsd, 0).toFixed(4)}`);
    }
    memory.close();
}
async function cmdBest(args) {
    const memory = new ExperimentMemory();
    const goalId = extractArg(args, '--goal-id');
    if (!goalId) {
        const all = memory.getHistory();
        if (all.length === 0) {
            console.log('No results.');
            memory.close();
            return;
        }
        // Find best overall
        const best = all.reduce((b, r) => (r.score !== null && (!b || r.score > (b.score ?? 0)) ? r : b), all[0]);
        printBest(best);
    }
    else {
        const best = memory.getBest(goalId);
        if (!best) {
            console.log(`No best result for "${goalId}".`);
        }
        else
            printBest(best);
    }
    memory.close();
    function printBest(r) {
        console.log(`\n🏆 Best for "${r.armId}" — score ${r.score ?? 'N/A'}/10`);
        console.log(`${'─'.repeat(60)}`);
        console.log(r.output.slice(0, 1000));
        if (r.output.length > 1000)
            console.log(`\n... (${r.output.length - 1000} more chars)`);
        console.log(`${'─'.repeat(60)}`);
    }
}
function cmdConfig(args) {
    if (args.includes('--init')) {
        const cfg = defaultConfig();
        mkdirSync(join(homedir(), '.modelab'), { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
        console.log(`✅ Default config written to ${CONFIG_PATH}`);
        console.log('\nEdit the config to add your API keys:');
        console.log('  nano', CONFIG_PATH);
        console.log('\nThen run: modelab run --goal "your question here"');
        return;
    }
    if (args.includes('--list')) {
        const config = loadConfig();
        console.log(JSON.stringify(config, null, 2));
        return;
    }
    printHelp();
}
function cmdTemplates(args) {
    const templates = listTemplates();
    console.log(`\n🌑 Built-in templates (${templates.length})\n`);
    for (const t of templates) {
        console.log(`  ${t.id.padEnd(16)} ${t.name}`);
        console.log(`    ${t.description}`);
        console.log(`    Models: ${t.recommendedModels?.join(', ') ?? 'any'}`);
        console.log(`    Tags: ${t.tags?.join(', ')}`);
        console.log('');
    }
    console.log('Use: modelab run --goal "..." --template <id>');
}
function cmdExport(args) {
    const runId = args.find(a => !a.startsWith('--'));
    const format = (extractArg(args, '--format') ?? 'md');
    const outputPath = extractArg(args, '--output');
    if (!runId) {
        console.error('Usage: modelab export <run-id> [--format json|md|html] [--output <path>]');
        process.exit(1);
    }
    const memory = new ExperimentMemory();
    const results = memory.getHistory();
    const runResults = results.filter(r => r.runId === runId);
    if (runResults.length === 0) {
        console.error(`❌ No run found with ID: ${runId}`);
        console.error('Run: modelab history to see past runs.');
        memory.close();
        process.exit(1);
    }
    // Reconstruct RunLog
    const { runId: _r0, goalId: _g0, ...first } = runResults[0];
    const log = {
        goalId: _g0,
        runId,
        status: 'completed',
        startedAt: first.timestamp,
        completedAt: runResults[runResults.length - 1].timestamp,
        totalCostUsd: runResults.reduce((s, r) => s + r.costUsd, 0),
        bestResult: runResults.reduce((b, r) => r.score !== null && (!b || r.score > (b.score ?? 0)) ? r : b, runResults[0]),
        allResults: runResults,
    };
    const content = exportRun(log, {
        format,
        includeScores: true,
        includeCost: true,
        includeMetadata: true,
        theme: 'dark',
    });
    if (outputPath) {
        writeFileSync(outputPath, content);
        console.log(`📄 Exported to ${outputPath}`);
    }
    else {
        console.log(content);
    }
    memory.close();
}
function cmdRoute(args) {
    const task = extractArg(args, '--task') ?? 'hello world';
    const modeArg = extractArg(args, '--mode') ?? 'quality';
    const mode = (['quality', 'latency', 'cost'].includes(modeArg) ? modeArg : 'quality');
    const config = loadConfig();
    const routed = routeTask(task, config.models, mode);
    console.log(`\nTask: "${task}"`);
    console.log(`Mode: ${mode}`);
    console.log(`Routed to: ${routed.model} (${routed.provider})`);
    console.log(`Reasoning: ${routed.reasoning}`);
}
function cmdCache(args) {
    if (args.includes('--clear')) {
        const cache = new Cache();
        const size = cache.size();
        cache.clear();
        console.log(`🗑️  Cleared ${size} cached entries.`);
        return;
    }
    const cache = new Cache(CACHE_TTL);
    console.log(`\n🗃️  Cache: ${cache.size()} entries`);
    console.log(`   Location: ${join(homedir(), '.modelab', 'cache.json')}`);
    console.log(`   TTL: 7 days\n`);
}
// ── Entry point ────────────────────────────────────────────────────────────
const subcommand = process.argv[2];
const subArgs = process.argv.slice(3);
switch (subcommand) {
    case 'run':
        cmdRun(subArgs);
        break;
    case 'history':
        cmdHistory(subArgs);
        break;
    case 'best':
        cmdBest(subArgs);
        break;
    case 'config':
        cmdConfig(subArgs);
        break;
    case 'templates':
        cmdTemplates(subArgs);
        break;
    case 'export':
        cmdExport(subArgs);
        break;
    case 'route':
        cmdRoute(subArgs);
        break;
    case 'cache':
        cmdCache(subArgs);
        break;
    case 'lessons':
        cmdLessons(subArgs);
        break;
    case 'report':
        cmdReport(subArgs);
        break;
    case 'interactive':
        cmdInteractive();
        break;
    case '--help':
    case '-h':
    case undefined:
        printHelp();
        break;
    default:
        console.error(`❌ Unknown command: ${subcommand}`);
        printHelp();
        process.exit(1);
}
/**
 * Interactive selector — renders a navigable list in the terminal.
 * Arrow keys to move, Enter to select, 'q' to cancel.
 * Returns the selected item id, or undefined if cancelled.
 */
async function interactiveSelect(title, items, formatItem) {
    if (items.length === 0)
        return undefined;
    if (process.stdout.isTTY === false) {
        // Non-TTY: just return the first item silently
        return items[0].id;
    }
    let selected = 0;
    function render() {
        process.stdout.write('\x1b[?25l'); // hide cursor
        process.stdout.write('\x1b[2J'); // clear screen
        process.stdout.write('\x1b[H'); // home
        console.log(title);
        console.log('');
        for (let i = 0; i < items.length; i++) {
            const line = formatItem(items[i], i === selected, i);
            if (i === selected) {
                console.log('\x1b[36m\x1b[1m\x1b[7m ' + line.slice(1) + ' \x1b[0m'); // cyan+bold+inverse for selected
            }
            else {
                console.log('  ' + line);
            }
        }
        console.log('');
        console.log('\x1b[2m↑↓ navigate · Enter select · q cancel\x1b[0m');
    }
    return new Promise((resolve) => {
        const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        // Enable raw mode for single-key capture
        const prevRaw = process.stdin.isRaw ?? false;
        try {
            require('readline').emitKeypressEvents(process.stdin);
            if (process.stdin.isTTY && !process.stdin.isRaw) {
                process.stdin.isRaw = true;
            }
        }
        catch {
            // fallback: let readline handle it
        }
        render();
        const handler = (chunk, key) => {
            if (key.ctrl && chunk === 'c') {
                cleanup();
                resolve(undefined);
                return;
            }
            if (key.name === 'q' || (key.name === 'escape' && !key.ctrl)) {
                cleanup();
                resolve(undefined);
                return;
            }
            if (key.name === 'up' || key.name === 'left') {
                selected = (selected - 1 + items.length) % items.length;
                render();
            }
            else if (key.name === 'down' || key.name === 'right') {
                selected = (selected + 1) % items.length;
                render();
            }
            else if (key.name === 'return' || key.name === 'enter') {
                cleanup();
                resolve(items[selected].id);
            }
        };
        function cleanup() {
            process.stdout.write('\x1b[?25h'); // show cursor
            process.stdout.write('\x1b[0m'); // reset attributes
            process.stdout.write('\x1b[2J');
            process.stdout.write('\x1b[H');
            try {
                process.stdin.removeListener('keypress', handler);
            }
            catch { /* ignore */ }
            try {
                rl.close();
            }
            catch { /* ignore */ }
        }
        try {
            process.stdin.on('keypress', handler);
        }
        catch {
            cleanup();
            resolve(undefined);
        }
    });
}
/** Read a line with a prompt, returning the trimmed input. */
async function readLine(prompt) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question('\x1b[1m' + prompt + '\x1b[0m ', (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
// ── Report ─────────────────────────────────────────────────────────────────────
/**
 * Pretty-print a full run report — shows run summary, iteration lessons,
 * latency breakdown, and per-arm results in a terminal-friendly format.
 */
async function cmdReport(args) {
    const memory = new ExperimentMemory();
    const runId = args.find(a => !a.startsWith('--'));
    if (!runId) {
        console.error('Usage: modelab report <run-id>');
        memory.close();
        process.exit(1);
    }
    const summary = memory.getRun(runId);
    if (!summary) {
        console.error(`❌ No run found with ID: ${runId}`);
        console.error('Run: modelab history to see past runs.');
        memory.close();
        process.exit(1);
    }
    const latency = summary.latencyStats;
    console.log('');
    console.log(`\x1b[36m\x1b[1m🌑 Run Report — ${runId.slice(0, 8)}…\x1b[0m`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`  Goal:       ${summary.goalId}`);
    console.log(`  Status:     ${statusColor(summary.status)} ${summary.status}`);
    console.log(`  Duration:   ${(summary.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Total cost: $${summary.totalCostUsd.toFixed(4)}`);
    console.log(`  Arms:       ${summary.totalArms} | Iterations: ${summary.totalIterations}`);
    if (latency.sampleCount > 0) {
        console.log(`  TTFT:       avg ${latency.avgMs}ms · p50 ${latency.p50Ms}ms · p95 ${latency.p95Ms}ms (n=${latency.sampleCount})`);
    }
    if (summary.bestScore !== null) {
        console.log(`  Best:       \x1b[33m\u2605 ${summary.bestScore}/10\x1b[0m \u2014 ${summary.bestArmId} (iteration ${summary.bestIteration ?? '?'})`);
    }
    console.log(`${'─'.repeat(70)}`);
    if (summary.lesson) {
        console.log('\n\x1b[1m💡 Experiment lesson:\x1b[0m');
        console.log(`  ${summary.lesson}`);
    }
    if (summary.iterationSummaries.length > 0) {
        console.log('\n\x1b[1m📝 Per-iteration lessons:\x1b[0m');
        for (const s of summary.iterationSummaries) {
            const scoreStr = s.bestScore !== null ? ` \x1b[33m\u2605 ${s.bestScore}/10\x1b[0m` : '';
            console.log(`  Iteration ${s.iteration}${scoreStr} — ${s.bestArmId ?? '?'}: ${s.lesson}`);
        }
    }
    // Per-arm results
    const results = memory.getHistory(summary.goalId).filter(r => r.runId === runId);
    if (results.length > 0) {
        console.log(`\n\x1b[1m📊 Arms (${results.length}):\x1b[0m`);
        const sorted = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        for (const r of sorted) {
            const scoreStr = r.score !== null ? `\x1b[33m\u2605 ${r.score}/10\x1b[0m` : '  \u2014  ';
            const cached = r.cached ? ' \x1b[2m[cached]\x1b[0m' : '';
            const ttft = r.latencyMs > 0 ? ` · TTFT:${r.latencyMs}ms` : '';
            const truncated = r.output.length > 120 ? r.output.slice(0, 120) + '…' : r.output;
            console.log(`  ${r.armId}  ${scoreStr}  $${r.costUsd.toFixed(4)}${cached}${ttft}`);
            console.log(`    ${truncated.replace(/\n/g, ' ')}`);
        }
    }
    console.log(`${'─'.repeat(70)}\n`);
    memory.close();
}
function statusColor(status) {
    if (status.includes('quality'))
        return '\x1b[32m✅\x1b[0m';
    if (status.includes('budget'))
        return '\x1b[33m💸\x1b[0m';
    if (status === 'failed')
        return '\x1b[31m❌\x1b[0m';
    return '\x1b[32m🏁\x1b[0m';
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function extractArg(args, key) {
    const idx = args.indexOf(key);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
//# sourceMappingURL=cli.js.map