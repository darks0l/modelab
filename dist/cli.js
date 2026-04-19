#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { z } from 'zod';
import { ResearchOrchestrator } from './orchestrator.js';
import { ExperimentMemory } from './memory.js';
import { Cache } from './cache.js';
import { routeTaskV2, formatRoutingDecisionV2, formatModelProfile } from './routing_v2.js';
import { getLessonEngine } from './lesson_engine.js';
import { getTemplate, listTemplates } from './templates.js';
import { exportRun } from './export.js';
import { getEmbeddingStore } from './embedding_store.js';
import { CampaignManager, SELF_IMPROVEMENT_CAMPAIGN } from './campaign.js';
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
  modelab route --task <text> [--mode quality|latency|cost]  Show learned routing decision (v2)
  modelab profile <model-key>                  Show performance profile for a model
  modelab lessons [--goal-id <id>]        Show what the system learned across runs
  modelab stats [--goal-id <id>]           Show aggregate statistics (runs, cost, scores, latency)
  modelab experiments [--limit N] [--sort date|score|cost]  List all runs with summary stats
  modelab review [run-id]                 Interactive run review (full latency + lesson breakdown)
  modelab iterations [run-id] [--goal-id <id>]  Per-iteration breakdown (scores, TTFT, lessons)
  modelab recall <query>                  Semantic search over past runs and lessons
  modelab campaign [subcommand]            Multi-run research campaigns (see CAMPAIGNS below)
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
                           Route for minimum latency (learns from latency history)
  modelab route --task <text> --mode cost
                           Route for minimum cost

EXAMPLES
  modelab run --goal "What causes migraines?" --threshold 8
  modelab run --goal "Review my API design" --template code-review --arms balanced,coding
  modelab run --goal "Compare Postgres vs DynamoDB" --template compare --arms balanced,reasoning
  modelab run --goal "Write a short poem" --temperature-sweep 0,0.3,0.7,1.0 --arms balanced
  modelab export run-abc123 --format html --output report.html

CAMPAIGNS (multi-run research)
  modelab campaign new "<question>" [--hypothesis "<text>"] [--runs N]
                           Create a multi-run research campaign
  modelab campaign run <id>   Run the next experiment in a campaign
  modelab campaign status [id]  Show campaign status (all if no id)
  modelab campaign report <id>  Full report with all runs and synthesis
  modelab campaign self       Create the self-improvement campaign
  modelab campaign self-run   Run the next self-improvement experiment
  modelab campaign synthesize <id>  Force re-synthesis of findings
  modelab campaigns           List all campaigns

CAMPAIGN EXAMPLES
  modelab campaign new "Does temperature affect code quality?" --hypothesis "Lower temp = better code" --runs 5
  modelab campaign self-run    (modelab improves itself through structured experimentation)

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
 * modelab stats [--goal-id <id>]
 * Show aggregate statistics across all runs or a specific goal.
 */
async function cmdStats(args) {
    const memory = new ExperimentMemory();
    const goalId = extractArg(args, '--goal-id');
    const stats = memory.getAggregateStats(goalId ?? undefined);
    memory.close();
    if (stats.totalRuns === 0) {
        console.log('\nNo experiments yet. Run: modelab run --goal "..."\n');
        return;
    }
    const label = goalId ? `Goal: ${goalId}` : 'All experiments';
    console.log('\n');
    console.log('  \x1b[36m\x1b[1m🌑 modelab — Statistics\x1b[0m');
    console.log(`  ${label}`);
    console.log('  ' + '\u2500'.repeat(64));
    // Runs
    const statusParts = [];
    for (const [status, count] of Object.entries(stats.runsByStatus)) {
        const icons = {
            quality_reached: '\x1b[32m\u2705 quality\x1b[0m',
            completed: '\x1b[32m\u2705 completed\x1b[0m',
            budget_exceeded: '\x1b[33m\U0001f4b8 budget\x1b[0m',
            failed: '\x1b[31m\u274c failed\x1b[0m',
            running: '\x1b[34m\u25b6 running\x1b[0m',
        };
        statusParts.push(`${icons[status] ?? status} ${count}`);
    }
    console.log(`  \x1b[2mRuns:\x1b[0m        ${stats.totalRuns} total  (${statusParts.join(' · ')})`);
    // Iterations & arms
    const iterStr = stats.avgIterationsPerRun !== null
        ? `  ·  avg ${stats.avgIterationsPerRun}/run`
        : '';
    console.log(`  \x1b[2mIterations:\x1b[0m   ${stats.totalIterations} total  ·  ${stats.totalArmRuns} arm runs${iterStr}`);
    // Goals
    console.log(`  \x1b[2mGoals:\x1b[0m         ${stats.goalsStudied}`);
    // Cost
    console.log(`  \x1b[2mCost:\x1b[0m          $${stats.totalCostUsd.toFixed(4)} total  ·  $${stats.avgCostPerRun.toFixed(4)} avg/run`);
    // Score
    const scoreStr = stats.avgScore !== null ? `${stats.avgScore.toFixed(1)}/10 avg` : 'N/A';
    const bestStr = stats.bestScore !== null ? `${stats.bestScore}/10 best (${stats.bestArmId})` : 'N/A';
    console.log(`  \x1b[2mQuality:\x1b[0m        ${scoreStr}  ·  ${bestStr}`);
    // Latency
    if (stats.avgLatencyMs !== null) {
        const bestLatStr = stats.bestLatencyMs !== null && stats.bestLatencyArmId
            ? `  ·  best ${stats.bestLatencyMs}ms (${stats.bestLatencyArmId})`
            : '';
        console.log(`  \x1b[2mTTFT latency:\x1b[0m   avg ${stats.avgLatencyMs}ms  ·  p50 ${stats.p50LatencyMs}ms  ·  p95 ${stats.p95LatencyMs}ms${bestLatStr}`);
    }
    else {
        console.log(`  \x1b[2mTTFT latency:\x1b[0m   no data`);
    }
    // Model breakdown
    if (Object.keys(stats.armsByModel).length > 0) {
        console.log('  ' + '\u2500'.repeat(64));
        console.log('  \x1b[1mModel usage\x1b[0m');
        const sorted = [...Object.entries(stats.armsByModel)].sort((a, b) => b[1] - a[1]);
        const maxCount = Math.max(...sorted.map(([, c]) => c), 1);
        for (const [model, count] of sorted) {
            const barLen = Math.round((count / maxCount) * 20);
            const bar = '\u2588'.repeat(barLen) + '\u2591'.repeat(20 - barLen);
            console.log(`  \x1b[2m${model.padEnd(16)}\x1b[0m ${bar} ${count}`);
        }
    }
    // Goal breakdown
    if (stats.goalsStudied > 1) {
        console.log('  ' + '\u2500'.repeat(64));
        console.log('  Run model: \x1b[2mmodelab insights\x1b[0m for per-(task, model) breakdown');
    }
    console.log('  ' + '\u2500'.repeat(64));
    console.log(`  \x1b[2mFilter: --goal-id <id> to scope stats to a specific goal\x1b[0m\n`);
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
/**
 * List per-iteration breakdown for a run.
 * Usage: modelab iterations <run-id> [--goal-id <id>]
 *        modelab iterations --goal-id <id>   (all runs for that goal)
 *        modelab iterations                  (most recent run)
 */
async function cmdIterations(args) {
    const memory = new ExperimentMemory();
    const runId = args.find(a => !a.startsWith('--'));
    const goalId = extractArg(args, '--goal-id');
    if (!runId && !goalId) {
        const summaries = memory.getRunSummaries();
        if (summaries.length === 0) {
            console.log('No runs found. Run: modelab run --goal "..."');
            memory.close();
            return;
        }
        printIterations(summaries[0].runId, summaries[0].goalId, memory, false);
    }
    else if (runId) {
        const run = memory.getRun(runId);
        if (!run) {
            console.error(`No run found: ${runId}`);
            memory.close();
            process.exit(1);
        }
        printIterations(runId, run.goalId, memory, false);
    }
    else {
        const summaries = memory.getRunSummaries(goalId);
        if (summaries.length === 0) {
            console.log(`No runs found for goal: ${goalId}`);
            memory.close();
            return;
        }
        for (const run of summaries) {
            printIterations(run.runId, run.goalId, memory, true);
        }
    }
    memory.close();
}
function printIterations(runId, goalId, memory, showRunHeader = false) {
    const summaries = memory.getSummaries(goalId, runId).sort((a, b) => a.iteration - b.iteration);
    if (summaries.length === 0) {
        console.log(`No iteration data for run ${runId.slice(0, 8)}…`);
        return;
    }
    if (showRunHeader) {
        console.log(`\n\x1b[36m\x1b[1m▶ Run ${runId.slice(0, 8)}…\x1b[0m  goal: ${goalId.slice(0, 40)}`);
    }
    else {
        console.log(`\n\x1b[36m\x1b[1m🌑 Iterations — Run ${runId.slice(0, 8)}…\x1b[0m  goal: ${goalId.slice(0, 40)}`);
    }
    console.log(`${'─'.repeat(70)}`);
    for (const s of summaries) {
        const scoreStr = s.bestScore !== null ? `\x1b[33m⭐ ${s.bestScore.toFixed(1)}\x1b[0m` : '—  ';
        const latencyStr = s.bestLatencyMs !== null ? ` · TTFT ${s.bestLatencyMs}ms` : '';
        console.log(`\n  Iteration ${s.iteration}  ${scoreStr}  (${s.bestArmId ?? '?'})${latencyStr}`);
        if (s.lesson)
            console.log(`    \x1b[2m${s.lesson.slice(0, 80)}\x1b[0m`);
        if (s.whatWorked)
            console.log(`    \x1b[32m✓\x1b[0m ${s.whatWorked.slice(0, 100)}…`);
        if (s.whatDidntWork)
            console.log(`    \x1b[31m✗\x1b[0m ${s.whatDidntWork.slice(0, 80)}…`);
    }
    console.log();
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
    const memory = new ExperimentMemory();
    // Use learned routing v2 — falls back to keyword router if no history
    const routed = routeTaskV2(task, config.models, mode, memory);
    console.log(formatRoutingDecisionV2(routed));
    memory.close();
}
function cmdProfile(args) {
    const modelKey = extractArg(args, '--model') ?? args.filter(a => !a.startsWith('--'))[0];
    if (!modelKey) {
        console.error('❌ Usage: modelab profile <model-key>  (e.g. modelab profile balanced)');
        process.exit(1);
    }
    const config = loadConfig();
    if (!config.models[modelKey]) {
        console.error(`❌ Unknown model key: "${modelKey}". Available: ${Object.keys(config.models).join(', ')}`);
        process.exit(1);
    }
    const cfg = config.models[modelKey];
    const engine = getLessonEngine();
    const dbProfile = engine.getProfile(modelKey);
    if (dbProfile) {
        console.log(formatModelProfile({
            key: modelKey,
            provider: cfg.provider,
            model: cfg.model,
            avgScore: dbProfile.avgScore,
            avgLatencyMs: dbProfile.avgLatencyMs,
            avgCostUsd: dbProfile.avgCostUsd,
            strengths: dbProfile.strengths,
            weaknesses: dbProfile.weaknesses,
            sampleSize: dbProfile.runsCount,
        }));
    }
    else {
        console.log(formatModelProfile({
            key: modelKey, provider: cfg.provider, model: cfg.model,
            avgScore: 5, avgLatencyMs: null, avgCostUsd: null,
            strengths: [], weaknesses: [], sampleSize: 0,
        }));
    }
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
/**
 * modelab recall <query>
 * Semantic search over past runs and lessons using the embedding store.
 */
async function cmdRecall(args) {
    const query = extractArg(args, '--query') ?? args.filter(a => !a.startsWith('--'))[0];
    if (!query) {
        console.error('❌ Usage: modelab recall <query>  or  modelab recall --query <text>');
        console.error('   Example: modelab recall "what models performed best on code tasks?"');
        process.exit(1);
    }
    const limit = parseInt(extractArg(args, '--limit') ?? '10', 10);
    const store = getEmbeddingStore();
    console.log(`\n🔍 Searching for: "${query}"\n`);
    try {
        const results = await store.search(query, limit);
        if (results.length === 0) {
            console.log('No matching runs or lessons found. Try different keywords.');
            store.close();
            return;
        }
        const runResults = results.filter(r => r.source === 'run');
        const lessonResults = results.filter(r => r.source === 'lesson');
        if (runResults.length > 0) {
            console.log(`📜 Matching runs (${runResults.length}):\n`);
            for (const r of runResults.slice(0, 5)) {
                const goal = (r.goalText ?? r.runId ?? '').slice(0, 60);
                const score = (r.score * 100).toFixed(0);
                console.log(`  [${score}% match] ${goal}${goal.length >= 60 ? '…' : ''}`);
                console.log(`    Run: ${r.runId} | Summary: ${(r.summaryText ?? '').slice(0, 80)}…\n`);
            }
        }
        if (lessonResults.length > 0) {
            console.log(`📚 Matching lessons (${lessonResults.length}):\n`);
            for (const r of lessonResults.slice(0, 5)) {
                const score = (r.score * 100).toFixed(0);
                const text = r.lessonText?.slice(0, 100) ?? '';
                console.log(`  [${score}% match] ${text}…\n`);
            }
        }
        console.log(`\n  ${results.length} total matches (query: "${query}", limit: ${limit})`);
        console.log(`  Use --limit N to show more results\n`);
    }
    catch (err) {
        console.error(`❌ Recall search failed:`, err instanceof Error ? err.message : String(err));
    }
    store.close();
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
    case 'profile':
        cmdProfile(subArgs);
        break;
    case 'cache':
        cmdCache(subArgs);
        break;
    case 'lessons':
        cmdLessons(subArgs);
        break;
    case 'recall':
        cmdRecall(subArgs);
        break;
    case 'stats':
        cmdStats(subArgs);
        break;
    case 'report':
        cmdReport(subArgs);
        break;
    case 'interactive':
        cmdInteractive();
        break;
    case 'experiments':
        cmdExperiments(subArgs);
        break;
    case 'insights':
        cmdInsights(subArgs);
        break;
    case 'review':
        cmdReview(subArgs);
        break;
    case 'iterations':
        cmdIterations(subArgs);
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
// ── Experiments (all runs summary) ─────────────────────────────────────────────────
/**
 * modelab experiments
 * Shows a summary table of all research runs with scores, cost, latency, and status.
 * Sortable by column. Best for finding which runs are worth a deeper look.
 */
async function cmdExperiments(args) {
    const memory = new ExperimentMemory();
    const limit = parseInt(extractArg(args, '--limit') ?? '20', 10);
    const sortBy = extractArg(args, '--sort') ?? 'date'; // date | score | cost
    const summaries = memory.getRunSummaries();
    if (summaries.length === 0) {
        console.log('\nNo research runs yet. Run: modelab run --goal "..."');
        memory.close();
        return;
    }
    // Sort
    const sorted = [...summaries];
    if (sortBy === 'score') {
        sorted.sort((a, b) => (b.bestScore ?? 0) - (a.bestScore ?? 0));
    }
    else if (sortBy === 'cost') {
        sorted.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
    }
    else {
        sorted.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    }
    const shown = sorted.slice(0, limit);
    const totalCost = summaries.reduce((s, r) => s + r.totalCostUsd, 0);
    const totalRuns = summaries.length;
    const avgScore = summaries.filter(r => r.bestScore !== null)
        .reduce((s, r, _, a) => s + (r.bestScore ?? 0) / a.length, 0);
    console.log('\n');
    console.log('  \x1b[36m\x1b[1m🌑 modelab — All Experiments\x1b[0m');
    console.log('  ' + '─'.repeat(80));
    console.log(`  \x1b[2mTotal runs: ${totalRuns}  ·  Total spend: $${totalCost.toFixed(4)}  ·  Avg best score: ${avgScore.toFixed(1)}/10\x1b[0m`);
    console.log('  ' + '─'.repeat(80));
    console.log('  \x1b[1m  DATE       RUN       GOAL                    STATUS     SCORE  COST      TTFT(p50)  ARMS ITERS\x1b[0m');
    console.log('  ' + '─'.repeat(80));
    for (const s of shown) {
        const date = new Date(s.startedAt).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
        const time = new Date(s.startedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const statusStr = s.status.replace('_', ' ').padEnd(10).slice(0, 10);
        const scoreStr = s.bestScore !== null ? `\x1b[33m${s.bestScore.toFixed(1)}/10\x1b[0m` : '    —  ';
        const costStr = `$${s.totalCostUsd.toFixed(4)}`;
        const latencyStr = s.latencyStats.sampleCount > 0 ? `${s.latencyStats.p50Ms}ms` : '  —  ';
        const goalTrunc = s.goalId.length > 22 ? s.goalId.slice(0, 22) + '…' : s.goalId.padEnd(22);
        const runIdShort = s.runId.slice(0, 8);
        const statusColor2 = s.status.includes('quality') ? '\x1b[32m' : s.status.includes('budget') ? '\x1b[33m' : s.status === 'failed' ? '\x1b[31m' : '\x1b[32m';
        console.log(`  ${date} ${time}  ${runIdShort}  ${goalTrunc}  ${statusColor2}${statusStr}\x1b[0m  ${scoreStr}  ${costStr.padStart(8)}  ${latencyStr.padStart(8)}   ${String(s.totalArms).padStart(4)}  ${String(s.totalIterations).padStart(5)}`);
    }
    console.log('  ' + '─'.repeat(80));
    console.log('  \x1b[2mSort: --sort date|score|cost  ·  Limit: --limit N  ·  Detail: modelab review <run-id>\x1b[0m\n');
    memory.close();
}
// ── Review (detailed single-run view) ───────────────────────────────────────────
// ── Campaign Commands ──────────────────────────────────────────────────────────
function extractCampaignArg(args, key) {
    const idx = args.indexOf(key);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
/**
 * modelab campaign new "<question>" [--hypothesis "<hypothesis>"] [--runs N]
 * Create a new research campaign.
 */
async function cmdCampaignNew(args) {
    const question = args[0];
    if (!question) {
        console.error('Usage: modelab campaign new "<question>" [--hypothesis "<hypothesis>"] [--runs N]');
        process.exit(1);
    }
    const hypothesis = extractCampaignArg(args, '--hypothesis') ?? '';
    const maxRuns = parseInt(extractCampaignArg(args, '--runs') ?? '5', 10);
    const config = loadConfig();
    const mgr = new CampaignManager(config);
    const campaign = mgr.createCampaign({ question, hypothesis, maxRuns });
    console.log(`\n🎯 Campaign created: ${campaign.id}`);
    console.log(`   Question: ${campaign.question}`);
    if (campaign.hypothesis)
        console.log(`   Hypothesis: ${campaign.hypothesis}`);
    console.log(`   Max runs: ${campaign.max_runs}`);
    console.log(`   Status: ${campaign.status}`);
    console.log('\nRun the next experiment: modelab campaign run', campaign.id);
    mgr.close();
}
/**
 * modelab campaign run <campaign_id>
 * Run the next experiment in the campaign.
 */
async function cmdCampaignRun(args) {
    const campaignId = args.find(a => !a.startsWith('--'));
    if (!campaignId) {
        console.error('Usage: modelab campaign run <campaign_id>');
        process.exit(1);
    }
    const config = loadConfig();
    const mgr = new CampaignManager(config);
    const campaign = mgr.getCampaign(campaignId);
    if (!campaign) {
        console.error(`❌ Campaign not found: ${campaignId}`);
        mgr.close();
        process.exit(1);
    }
    const modelKeys = Object.keys(config.models);
    const arms = modelKeys.slice(0, Math.min(modelKeys.length, 3)).map((key, i) => ({
        id: `camp-arm-${i + 1}`,
        name: `${key} (${config.models[key].provider})`,
        promptTemplate: `You are a research assistant.\n\nGoal: {{goal}}\nQuestion: {{question}}\n\n{{iteration_context}}\n\nProvide a thorough, well-reasoned response.`,
        model: key,
    }));
    console.log(`\n🎯 Running campaign ${campaignId} (run #${campaign.total_runs + 1}/${campaign.max_runs})`);
    console.log(`   Question: ${campaign.question}`);
    if (campaign.hypothesis)
        console.log(`   Hypothesis: ${campaign.hypothesis}`);
    console.log(`   Arms: ${arms.map(a => a.id).join(', ')}\n`);
    try {
        const { campaign: updated, runLog, synthesis } = await mgr.runNext(campaignId, arms);
        console.log(`\n🏁 Run complete`);
        console.log(`   Campaign status: ${updated.status}`);
        console.log(`   Total runs: ${updated.total_runs}/${updated.max_runs}`);
        console.log(`   Cost so far: $${runLog.totalCostUsd.toFixed(4)}`);
        if (runLog.bestResult) {
            console.log(`   Best: ${runLog.bestResult.armId} — ⭐ ${runLog.bestResult.score}/10`);
        }
        console.log('\n📋 Synthesis:');
        console.log(`   ${synthesis.finding}`);
        console.log(`   Belief: ${synthesis.belief_change} | Confidence: ${(synthesis.confidence * 100).toFixed(0)}%`);
        if (synthesis.next_run_recommendation) {
            console.log(`   Next: ${synthesis.next_run_recommendation}`);
        }
        if (synthesis.stop_reason) {
            console.log(`   Stop reason: ${synthesis.stop_reason}`);
        }
        if (updated.status === 'running' && updated.total_runs < updated.max_runs) {
            console.log('\n   → Run the next experiment: modelab campaign run', campaignId);
        }
        else if (updated.status === 'complete') {
            console.log('\n📊 Full report: modelab campaign report', campaignId);
        }
    }
    catch (err) {
        console.error(`❌ Campaign run failed:`, err);
    }
    mgr.close();
}
/**
 * modelab campaign status [campaign_id]
 * Show campaign progress and latest synthesis.
 * If no id given, list all campaigns.
 */
async function cmdCampaignStatus(args) {
    const campaignId = args.find(a => !a.startsWith('--'));
    if (!campaignId) {
        const config = loadConfig();
        const mgr = new CampaignManager(config);
        const statusFilter = extractCampaignArg(args, '--status');
        const campaigns = mgr.listCampaigns(statusFilter);
        if (campaigns.length === 0) {
            console.log('\nNo campaigns yet. Create one: modelab campaign new "<question>" [--hypothesis "<hypothesis>"]');
            mgr.close();
            return;
        }
        console.log('\n');
        console.log('  \x1b[36m\x1b[1m🎯 Campaigns\x1b[0m');
        console.log('  ' + '─'.repeat(72));
        for (const c of campaigns) {
            const sc = c.status === 'complete' ? '\x1b[32m' : c.status === 'running' ? '\x1b[34m' : c.status === 'failed' ? '\x1b[31m' : '\x1b[33m';
            console.log(`  ${sc}${c.status.padEnd(12)}\x1b[0m ${c.id}  runs:${c.total_runs}/${c.max_runs}  ${c.question.slice(0, 40)}`);
        }
        console.log('  ' + '─'.repeat(72));
        console.log('\n  Detail: modelab campaign status <campaign_id>');
        console.log('  Run next: modelab campaign run <campaign_id>');
        mgr.close();
        return;
    }
    const config = loadConfig();
    const mgr = new CampaignManager(config);
    const campaign = mgr.getCampaign(campaignId);
    if (!campaign) {
        console.error(`❌ Campaign not found: ${campaignId}`);
        mgr.close();
        process.exit(1);
    }
    const report = mgr.getReport(campaignId);
    console.log('\n');
    console.log(`  \x1b[36m\x1b[1m🎯 Campaign: ${campaign.id}\x1b[0m`);
    console.log('  ' + '─'.repeat(72));
    console.log(`  Status:      ${campaign.status}`);
    console.log(`  Runs:        ${campaign.total_runs}/${campaign.max_runs}`);
    console.log(`  Question:    ${campaign.question}`);
    if (campaign.hypothesis)
        console.log(`  Hypothesis:  ${campaign.hypothesis}`);
    console.log(`  Created:     ${new Date(campaign.created_at).toLocaleString()}`);
    console.log(`  Updated:     ${new Date(campaign.updated_at).toLocaleString()}`);
    console.log('  ' + '─'.repeat(72));
    if (report && report.runs.length > 0) {
        console.log('\n  \x1b[1mRuns:\x1b[0m');
        for (const run of report.runs) {
            const scoreStr = run.bestScore !== null ? `\x1b[33m⭐ ${run.bestScore.toFixed(1)}/10\x1b[0m` : '  —  ';
            console.log(`  #${run.sequenceOrder}  ${scoreStr}  ${run.bestArm ?? '?'}  $${run.totalCostUsd.toFixed(4)}  — ${run.finding.slice(0, 60)}…`);
        }
        console.log(`\n  Total cost: $${report.totalCostUsd.toFixed(4)}`);
    }
    if (campaign.findings) {
        console.log('\n  \x1b[1mLatest finding:\x1b[0m');
        console.log(`  ${campaign.findings}`);
    }
    console.log('\n  ' + '─'.repeat(72));
    if (campaign.status === 'running') {
        console.log('  Run next: modelab campaign run', campaignId);
    }
    console.log('  Full report: modelab campaign report', campaignId);
    console.log('  Pause: modelab campaign pause', campaignId);
    console.log('');
    mgr.close();
}
/**
 * modelab campaign report <campaign_id>
 * Full campaign report with all runs and synthesized conclusion.
 */
async function cmdCampaignReport(args) {
    const campaignId = args.find(a => !a.startsWith('--'));
    if (!campaignId) {
        console.error('Usage: modelab campaign report <campaign_id>');
        process.exit(1);
    }
    const config = loadConfig();
    const mgr = new CampaignManager(config);
    const report = mgr.getReport(campaignId);
    if (!report) {
        console.error(`❌ Campaign not found: ${campaignId}`);
        mgr.close();
        process.exit(1);
    }
    const { campaign, runs, totalCostUsd } = report;
    console.log('\n');
    console.log(`  \x1b[36m\x1b[1m🎯 Campaign Report\x1b[0m — ${campaign.id}`);
    console.log('  ' + '─'.repeat(76));
    console.log(`  Question:    ${campaign.question}`);
    if (campaign.hypothesis)
        console.log(`  Hypothesis:  ${campaign.hypothesis}`);
    console.log(`  Status:      ${campaign.status}  |  Runs: ${runs.length}/${campaign.max_runs}  |  Cost: $${totalCostUsd.toFixed(4)}`);
    console.log('  ' + '─'.repeat(76));
    for (const run of runs) {
        console.log(`\n  \x1b[1m── Run #${run.sequenceOrder}\x1b[0m`);
        const scoreStr = run.bestScore !== null ? `\x1b[33m⭐ ${run.bestScore.toFixed(1)}/10\x1b[0m` : '  —  ';
        console.log(`  Best: ${run.bestArm ?? '?'} ${scoreStr}  |  $${run.totalCostUsd.toFixed(4)}  |  ${run.totalArms} arms`);
        console.log(`  Finding: ${run.finding}`);
        if (run.runContext) {
            console.log(`  Context: ${run.runContext.slice(0, 200)}`);
        }
        if (run.results.length > 0) {
            const sorted = [...run.results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
            for (const r of sorted.slice(0, 4)) {
                const s = r.score !== null ? `\x1b[33m${r.score.toFixed(1)}/10\x1b[0m` : '  —  ';
                console.log(`    ${r.armId.padEnd(20)} ${s}  $${r.costUsd.toFixed(4)}`);
            }
        }
    }
    if (campaign.findings) {
        console.log('\n  ' + '─'.repeat(76));
        console.log('  \x1b[1m📋 Final Synthesis:\x1b[0m');
        console.log(`  ${campaign.findings}`);
    }
    console.log('\n  ' + '─'.repeat(76));
    mgr.close();
}
/**
 * modelab campaign synthesize <campaign_id>
 * Force re-synthesis of all findings.
 */
async function cmdCampaignSynthesize(args) {
    const campaignId = args.find(a => !a.startsWith('--'));
    if (!campaignId) {
        console.error('Usage: modelab campaign synthesize <campaign_id>');
        process.exit(1);
    }
    const config = loadConfig();
    const mgr = new CampaignManager(config);
    console.log('\n🔄 Synthesizing all campaign findings…\n');
    try {
        const synthesis = await mgr.forceSynthesize(campaignId);
        console.log('\n📋 Synthesis result:');
        console.log(`   ${synthesis.finding}`);
        console.log(`   Belief: ${synthesis.belief_change} | Confidence: ${(synthesis.confidence * 100).toFixed(0)}%`);
        if (synthesis.next_run_recommendation) {
            console.log(`   Next: ${synthesis.next_run_recommendation}`);
        }
        if (synthesis.stop_reason) {
            console.log(`   Stop reason: ${synthesis.stop_reason}`);
        }
    }
    catch (err) {
        console.error(`❌ Synthesis failed:`, err);
    }
    mgr.close();
}
/**
 * Dispatcher for all campaign subcommands.
 */
async function cmdCampaign(args) {
    const sub = args[0];
    switch (sub) {
        case 'new':
            cmdCampaignNew(args.slice(1));
            break;
        case 'run':
            cmdCampaignRun(args.slice(1));
            break;
        case 'status':
            cmdCampaignStatus(args.slice(1));
            break;
        case 'report':
            cmdCampaignReport(args.slice(1));
            break;
        case 'synthesize':
            cmdCampaignSynthesize(args.slice(1));
            break;
        case 'pause': {
            const config = loadConfig();
            const mgr = new CampaignManager(config);
            const id = args[1];
            if (!id) {
                console.error('Usage: modelab campaign pause <campaign_id>');
                process.exit(1);
            }
            const updated = mgr.pauseCampaign(id);
            if (!updated) {
                console.error(`❌ Campaign not found: ${id}`);
                process.exit(1);
            }
            console.log(`Campaign ${id} paused.`);
            mgr.close();
            break;
        }
        case 'resume': {
            const config = loadConfig();
            const mgr = new CampaignManager(config);
            const id = args[1];
            if (!id) {
                console.error('Usage: modelab campaign resume <campaign_id>');
                process.exit(1);
            }
            const updated = mgr.resumeCampaign(id);
            if (!updated) {
                console.error(`❌ Campaign not found: ${id}`);
                process.exit(1);
            }
            console.log(`Campaign ${id} resumed.`);
            mgr.close();
            break;
        }
        case 'delete': {
            const config = loadConfig();
            const mgr = new CampaignManager(config);
            const id = args[1];
            if (!id) {
                console.error('Usage: modelab campaign delete <campaign_id>');
                process.exit(1);
            }
            mgr.deleteCampaign(id);
            console.log(`Campaign ${id} deleted.`);
            mgr.close();
            break;
        }
        case 'self': {
            const config = loadConfig();
            const mgr = new CampaignManager(config);
            const existing = mgr.listCampaigns('running').find(c => c.question === SELF_IMPROVEMENT_CAMPAIGN.question);
            if (existing) {
                console.log(`Self-improvement campaign already exists: ${existing.id}`);
                console.log(`Run: modelab campaign run ${existing.id}`);
                mgr.close();
                return;
            }
            const campaign = mgr.createCampaign({
                question: SELF_IMPROVEMENT_CAMPAIGN.question,
                hypothesis: SELF_IMPROVEMENT_CAMPAIGN.hypothesis,
                maxRuns: SELF_IMPROVEMENT_CAMPAIGN.maxRuns,
                convergenceThreshold: SELF_IMPROVEMENT_CAMPAIGN.convergenceThreshold,
            });
            console.log(`\n🌱 Self-improvement campaign created: ${campaign.id}`);
            console.log('   Question: What code changes would most improve modelab?');
            console.log(`   Max runs: ${campaign.max_runs}`);
            console.log('\nRun: modelab campaign self');
            console.log(`Or: modelab campaign run ${campaign.id}`);
            mgr.close();
            break;
        }
        case 'self-run': {
            const config = loadConfig();
            const mgr = new CampaignManager(config);
            let campaign = mgr.listCampaigns('running').find(c => c.question === SELF_IMPROVEMENT_CAMPAIGN.question);
            if (!campaign) {
                campaign = mgr.createCampaign({
                    question: SELF_IMPROVEMENT_CAMPAIGN.question,
                    hypothesis: SELF_IMPROVEMENT_CAMPAIGN.hypothesis,
                    maxRuns: SELF_IMPROVEMENT_CAMPAIGN.maxRuns,
                    convergenceThreshold: SELF_IMPROVEMENT_CAMPAIGN.convergenceThreshold,
                });
            }
            const arms = SELF_IMPROVEMENT_CAMPAIGN.buildArms();
            console.log(`\n🌱 Self-improvement campaign: ${campaign.id} (run #${campaign.total_runs + 1}/${campaign.max_runs})`);
            try {
                const { campaign: updated, runLog, synthesis } = await mgr.runNext(campaign.id, arms);
                console.log(`\n🏁 Run complete — ${updated.status}`);
                console.log(`   Synthesis: ${synthesis.finding}`);
                console.log(`   Belief: ${synthesis.belief_change} | Confidence: ${(synthesis.confidence * 100).toFixed(0)}%`);
                if (synthesis.next_run_recommendation)
                    console.log(`   Next: ${synthesis.next_run_recommendation}`);
                if (updated.status === 'running') {
                    console.log('\n   → Run again: modelab campaign self');
                }
            }
            catch (err) {
                console.error('Self-improvement run failed:', err);
            }
            mgr.close();
            break;
        }
        case 'help':
        case '--help':
            console.log(`
🎯 Campaign Commands

  modelab campaign new "<question>" [--hypothesis "<text>"] [--runs N]
    Create a new research campaign (default: 5 max runs)

  modelab campaign run <campaign_id>
    Run the next experiment in a campaign

  modelab campaign status [campaign_id]
    Show campaign status (or list all if no id given)

  modelab campaign report <campaign_id>
    Full campaign report with all runs and synthesis

  modelab campaign synthesize <campaign_id>
    Force re-synthesis of all findings

  modelab campaign pause <campaign_id>
    Pause a running campaign

  modelab campaign resume <campaign_id>
    Resume a paused campaign

  modelab campaign delete <campaign_id>
    Delete a campaign and its runs

  modelab campaign self
    Create the self-improvement campaign

  modelab campaign self-run
    Run the next self-improvement experiment (creates campaign if needed)
`);
            break;
        default:
            if (!sub || sub === 'campaigns') {
                await cmdCampaignStatus(args);
            }
            else {
                console.error(`❌ Unknown campaign command: ${sub}`);
                console.error('Run: modelab campaign help');
                process.exit(1);
            }
    }
}
/**
 * modelab review <run-id>
 * Full terminal report for a single run — latency breakdown, per-iteration lessons,
 * per-arm results, and what the system learned.
 */
async function cmdReview(args) {
    const memory = new ExperimentMemory();
    const runId = args.find(a => !a.startsWith('--'));
    if (!runId) {
        // Interactive run selector
        const summaries = memory.getRunSummaries();
        if (summaries.length === 0) {
            console.log('No runs to review. Run: modelab run --goal "..."');
            memory.close();
            return;
        }
        const items = summaries.slice(0, 30).map(s => ({
            id: s.runId,
            label: `${s.runId.slice(0, 8)}…  \x1b[33m${s.bestScore !== null ? s.bestScore.toFixed(1) + '/10' : '—'}\x1b[0m  ${s.status.replace('_', ' ')}  $${s.totalCostUsd.toFixed(4)}`,
            sublabel: new Date(s.startedAt).toLocaleString(),
        }));
        const selected = await interactiveSelect('\n\x1b[36m\x1b[1m🔍 Select a Run to Review\x1b[0m\n', items, (item) => `${item.label}  \x1b[2m${item.sublabel ?? ''}\x1b[0m`);
        if (!selected) {
            memory.close();
            return;
        }
        await printReview(memory, selected);
    }
    else {
        const summary = memory.getRun(runId);
        if (!summary) {
            console.error(`❌ No run found: ${runId}`);
            memory.close();
            process.exit(1);
        }
        await printReview(memory, runId);
    }
    memory.close();
}
async function printReview(memory, runId) {
    const summary = memory.getRun(runId);
    if (!summary)
        return;
    const latency = summary.latencyStats;
    const results = memory.getHistory(summary.goalId).filter(r => r.runId === runId);
    // Header
    console.log('\n');
    console.log('  \x1b[36m\x1b[1m🌑 Run Review\x1b[0m — ' + runId.slice(0, 8) + '…');
    console.log('  ' + '─'.repeat(74));
    // Meta row
    const statusStr = summary.status.replace('_', ' ');
    const statusCol = summary.status.includes('quality') ? '\x1b[32m✅ ' + statusStr : summary.status.includes('budget') ? '\x1b[33m💸 ' + statusStr : summary.status === 'failed' ? '\x1b[31m❌ ' + statusStr : '\x1b[32m🏁 ' + statusStr;
    console.log(`  ${statusCol}\x1b[0m  ·  Started: ${new Date(summary.startedAt).toLocaleString()}  ·  Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);
    // Score + cost row
    if (summary.bestScore !== null) {
        console.log(`  \x1b[33m\x1b[1m⭐ ${summary.bestScore}/10\x1b[0m ${summary.bestArmId} (iter ${summary.bestIteration ?? '?'})  ·  Cost: $${summary.totalCostUsd.toFixed(4)}  ·  Arms: ${summary.totalArms} × ${summary.totalIterations} iter`);
    }
    else {
        console.log(`  No scored results  ·  Cost: $${summary.totalCostUsd.toFixed(4)}  ·  Arms: ${summary.totalArms} × ${summary.totalIterations} iter`);
    }
    // Latency row (if we have data)
    if (latency.sampleCount > 0) {
        const bestLatStr = latency.bestMs !== null ? `  ·  Best: ${latency.bestMs}ms (${summary.iterationSummaries.find(s => s.bestLatencyMs === latency.bestMs)?.bestArmId ?? '?'})` : '';
        console.log(`  \x1b[2mTTFT:  avg ${latency.avgMs}ms  ·  p50 ${latency.p50Ms}ms  ·  p95 ${latency.p95Ms}ms  ·  min ${latency.minMs}ms  ·  max ${latency.maxMs}ms (n=${latency.sampleCount})${bestLatStr}\x1b[0m`);
    }
    // Lesson
    if (summary.lesson) {
        console.log('\n  \x1b[1m💡 Lesson:\x1b[0m');
        console.log(`  ${summary.lesson}`);
    }
    // Per-iteration breakdown
    if (summary.iterationSummaries.length > 0) {
        console.log('\n  \x1b[1m📝 Iteration Breakdown\x1b[0m');
        for (const s of summary.iterationSummaries) {
            const scoreStr = s.bestScore !== null ? `\x1b[33m⭐ ${s.bestScore}/10\x1b[0m` : '  —  ';
            const latencyStr = s.bestLatencyMs !== null ? `  TTFT:${s.bestLatencyMs}ms` : '';
            console.log(`  \x1b[36mIter ${s.iteration}\x1b[0m  ${scoreStr}  ${s.bestArmId ?? '?'}${latencyStr}`);
            if (s.lesson)
                console.log(`          ${s.lesson}`);
            if (s.whatWorked)
                console.log(`          \x1b[32m✓\x1b[0m ${s.whatWorked.slice(0, 120)}${s.whatWorked.length > 120 ? '…' : ''}`);
            if (s.whatDidntWork)
                console.log(`          \x1b[31m✗\x1b[0m ${s.whatDidntWork.slice(0, 120)}${s.whatDidntWork.length > 120 ? '…' : ''}`);
        }
    }
    // Per-arm results table
    if (results.length > 0) {
        console.log('\n  \x1b[1m📊 All Arms\x1b[0m');
        console.log('  ' + '─'.repeat(74));
        const sorted = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        for (const r of sorted) {
            const scoreStr = r.score !== null ? `\x1b[33m${r.score.toFixed(1)}/10\x1b[0m` : '     —  ';
            const cached = r.cached ? ' \x1b[2m[ch]\x1b[0m' : '';
            const ttft = r.latencyMs > 0 ? `  TTFT:${String(r.latencyMs).padStart(4)}ms` : '            ';
            const outLen = r.output.length;
            const truncated = r.output.replace(/\n/g, ' ').slice(0, 60).padEnd(60);
            console.log(`  ${r.armId.padEnd(20)} ${scoreStr}  $${r.costUsd.toFixed(4)}${cached}${ttft}  ${truncated}`);
        }
    }
    console.log('  ' + '─'.repeat(74));
    console.log('  Full output: modelab export ' + runId + ' --format md\n');
}
// ── Insights (model + task-type leaderboard) ──────────────────────────────────────
async function cmdInsights(args) {
    const memory = new ExperimentMemory();
    const filterType = extractArg(args, '--type') ?? 'all';
    const insights = memory.getModelInsights();
    if (insights.length === 0) {
        console.log('\nNo insights yet — run some experiments first: modelab run --goal "..."\n');
        memory.close();
        return;
    }
    const filtered = filterType !== 'all'
        ? insights.filter(i => i.taskType === filterType)
        : insights;
    const totalRuns = new Set(memory.getHistory().map(r => r.runId)).size;
    const totalCost = memory.getHistory().reduce((s, r) => s + r.costUsd, 0);
    const avgAll = insights.filter(i => i.avgScore !== null)
        .reduce((s, i, _, a) => s + (i.avgScore ?? 0) / a.length, 0);
    console.log('\n');
    console.log('  \x1b[36m\x1b[1m🌑 modelab — Experiment Insights\x1b[0m');
    console.log('  ' + '\u2500'.repeat(82));
    console.log(`  \x1b[2mTotal runs: ${totalRuns}  ·  Total spend: $${totalCost.toFixed(4)}  ·  Avg score: ${avgAll.toFixed(1)}/10\x1b[0m`);
    console.log('  ' + '\u2500'.repeat(82));
    if (filterType !== 'all') {
        console.log(`\n  Filter: \x1b[33m${filterType}\x1b[0m  (--type all to reset)\n`);
    }
    // Group by task type
    const byTask = new Map();
    for (const i of filtered) {
        const list = byTask.get(i.taskType) ?? [];
        list.push(i);
        byTask.set(i.taskType, list);
    }
    const taskLabels = {
        coding: '\x1b[35m💻 Coding\x1b[0m',
        reasoning: '\x1b[34m🧠 Reasoning\x1b[0m',
        general: '\x1b[36m📋 General\x1b[0m',
        quick: '\x1b[32m⚡ Quick\x1b[0m',
    };
    const taskOrder = ['coding', 'reasoning', 'general', 'quick'];
    for (const task of taskOrder) {
        const taskInsights = byTask.get(task);
        if (!taskInsights || taskInsights.length === 0)
            continue;
        console.log(`\n  ${taskLabels[task] ?? task} (${taskInsights.length} combos)\n`);
        console.log('  \x1b[2m  ARM FAMILY         VERDICT                                       SCORE   WIN RATE  TTFT      COST/RUN\x1b[0m');
        console.log('  ' + '\u2500'.repeat(82));
        for (const i of taskInsights.slice(0, 8)) {
            const scoreStr = i.avgScore !== null ? `\x1b[33m${i.avgScore.toFixed(1)}\x1b[0m` : '   —   ';
            const winStr = i.winRate > 0 ? `\x1b[32m${(i.winRate * 100).toFixed(0)}%\x1b[0m` : '  —  ';
            const ttftStr = i.avgLatencyMs !== null ? `${Math.round(i.avgLatencyMs)}ms` : '   —   ';
            const costStr = i.avgCostUsd !== null ? `$${i.avgCostUsd.toFixed(4)}` : '   —   ';
            const tempStr = i.temperature !== null ? `T=${i.temperature}` : '';
            const armLabel = (i.armFamily + (tempStr ? ` (${tempStr})` : '')).padEnd(18);
            const verdictTrunc = i.verdict.slice(0, 43).padEnd(43);
            console.log(`  ${armLabel} ${verdictTrunc}  ${scoreStr}  ${winStr.padStart(7)}  ${ttftStr.padStart(7)}  ${costStr}`);
        }
    }
    // Top lessons
    const lessons = memory.getLessons();
    if (lessons.length > 0) {
        console.log(`\n  \x1b[1m💡 Top Lessons (${Math.min(lessons.length, 5)} of ${lessons.length})\x1b[0m`);
        console.log('  ' + '\u2500'.repeat(82));
        for (const l of lessons.slice(0, 5)) {
            const scoreStr = l.bestScore !== null ? ` \x1b[33m⭐${l.bestScore}/10\x1b[0m` : '';
            console.log(`  \x1b[2mIter ${l.iteration}\x1b[0m${scoreStr}: ${l.lesson.slice(0, 70)}`);
        }
    }
    console.log('\n  \x1b[2mFilter: --type coding|reasoning|general|quick|all\x1b[0m\n');
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