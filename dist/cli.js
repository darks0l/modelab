#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { ResearchOrchestrator } from './orchestrator.js';
import { ExperimentMemory } from './memory.js';
import { routeTask } from './router.js';
const CONFIG_PATH = join(homedir(), '.modelab', 'config.json');
const ConfigSchema = z.object({
    models: z.record(z.object({
        provider: z.enum(['openai', 'anthropic', 'ollama', 'openrouter']),
        model: z.string(),
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        costPerMillionInput: z.number().optional(),
        costPerMillionOutput: z.number().optional(),
    })),
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
        console.error('Run: modelab config --init to create a default config');
        process.exit(1);
    }
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return ConfigSchema.parse(raw);
}
function printHelp() {
    console.log(`modelab — autonomous research agent SDK

Usage:
  modelab run --goal <text> [--iterations N] [--threshold N] [--arms N]
               Run a research goal with N arms in parallel

  modelab history [--goal-id <id>]
               Show experiment history from memory DB

  modelab best [--goal-id <id>]
               Show best result for a goal

  modelab config --init
               Create default config at ${CONFIG_PATH}

  modelab config --list
               Show current config

  modelab route --task <text>
               Show which model would be routed for a task

  modelab --help
               Show this help

Environment:
  OPENAI_API_KEY      — used when model config has no apiKey
  ANTHROPIC_API_KEY   — used for Anthropic models
  OLLAMA_HOST         — defaults to http://localhost:11434
`);
}
async function cmdRun(args) {
    const config = loadConfig();
    const memory = new ExperimentMemory();
    let goalText = '';
    let maxIterations = 3;
    let qualityThreshold = 7.0;
    let numArms = 2;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--goal' && args[i + 1])
            goalText = args[++i];
        else if (args[i] === '--iterations' && args[i + 1])
            maxIterations = parseInt(args[++i], 10);
        else if (args[i] === '--threshold' && args[i + 1])
            qualityThreshold = parseFloat(args[++i]);
        else if (args[i] === '--arms' && args[i + 1])
            numArms = parseInt(args[++i], 10);
    }
    if (!goalText) {
        console.error('--goal is required');
        process.exit(1);
    }
    const goalId = `goal-${Date.now()}`;
    const now = new Date().toISOString();
    // Auto-generate arms from available models
    const modelKeys = Object.keys(config.models);
    const arms = modelKeys.slice(0, Math.min(numArms, modelKeys.length)).map((key, i) => ({
        id: `${key}-arm-${i + 1}`,
        name: `${key} strategy`,
        promptTemplate: `You are a research agent. Your task:\n\nGoal: {{goal}}\n\nQuestion: {{question}}\n\nProvide a thorough, well-reasoned response.`,
        model: key,
    }));
    const goal = {
        id: goalId,
        question: goalText,
        goal: goalText,
        qualityThreshold,
        maxIterations,
        arms,
    };
    const orchestrator = new ResearchOrchestrator({
        models: config.models,
        budget: config.budget,
        evalModel: config.evalModel,
        parallelism: config.parallelism,
        memory,
    });
    console.log(`[modelab] Goal: ${goalText}`);
    console.log(`[modelab] Arms: ${arms.map(a => a.name).join(', ')}`);
    const log = await orchestrator.run(goal);
    console.log('\n=== RESULT ===');
    console.log(`Status: ${log.status}`);
    console.log(`Total cost: $${log.totalCostUsd.toFixed(4)}`);
    if (log.bestResult) {
        console.log(`Best score: ${log.bestResult.score} (arm: ${log.bestResult.armId})`);
        console.log(`Best output:\n${log.bestResult.output.slice(0, 500)}${log.bestResult.output.length > 500 ? '\n...' : ''}`);
    }
    memory.close();
}
async function cmdHistory(args) {
    const memory = new ExperimentMemory();
    const goalId = extractArg(args, '--goal-id');
    const results = memory.getHistory(goalId ?? undefined);
    if (results.length === 0) {
        console.log('No experiments found.');
    }
    else {
        console.log(`\n=== History (${results.length} results) ===`);
        for (const r of results.slice(0, 20)) {
            console.log(`[${r.timestamp}] arm=${r.armId} score=${r.score ?? 'N/A'} cost=$${r.costUsd.toFixed(4)} tokens=${r.tokensUsed.input + r.tokensUsed.output}`);
            console.log(`  ${r.output.slice(0, 120)}...`);
            console.log('');
        }
    }
    memory.close();
}
async function cmdBest(args) {
    const memory = new ExperimentMemory();
    const goalId = extractArg(args, '--goal-id') ?? 'last';
    const best = memory.getBest(goalId);
    if (!best) {
        console.log('No best result found.');
    }
    else {
        console.log(`Best result (score=${best.score}):\n${best.output}`);
    }
    memory.close();
}
function cmdConfig(args) {
    if (args.includes('--init')) {
        const defaultConfig = {
            models: {
                fast: {
                    provider: 'openai',
                    model: 'gpt-4o-mini',
                    costPerMillionInput: 0.15,
                    costPerMillionOutput: 0.60,
                },
                balanced: {
                    provider: 'anthropic',
                    model: 'claude-sonnet-4-6',
                    costPerMillionInput: 3,
                    costPerMillionOutput: 15,
                },
                reasoning: {
                    provider: 'openai',
                    model: 'o1',
                    costPerMillionInput: 15,
                    costPerMillionOutput: 60,
                },
                coding: {
                    provider: 'ollama',
                    model: 'qwen3-coder',
                    baseUrl: 'http://localhost:11434',
                    costPerMillionInput: 0,
                    costPerMillionOutput: 0,
                },
            },
            evalModel: 'balanced',
            budget: { maxPerRun: 2.0, maxPerExperiment: 0.5, trackCosts: true },
            parallelism: 3,
        };
        const { mkdirSync, writeFileSync } = require('fs');
        mkdirSync(join(homedir(), '.modelab'), { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
        console.log(`Default config written to ${CONFIG_PATH}`);
        return;
    }
    if (args.includes('--list')) {
        const config = loadConfig();
        console.log(JSON.stringify(config, null, 2));
        return;
    }
    printHelp();
}
function cmdRoute(args) {
    const task = extractArg(args, '--task') ?? 'hello world';
    const config = loadConfig();
    const routed = routeTask(task, config.models);
    console.log(`Task: "${task}"`);
    console.log(`Routed to: ${routed.model} (${routed.provider})`);
}
function extractArg(args, key) {
    const idx = args.indexOf(key);
    return idx !== -1 ? args[idx + 1] : undefined;
}
// ── Entry point ─────────────────────────────────────────────────
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
    case 'route':
        cmdRoute(subArgs);
        break;
    case '--help':
    case '-h':
    case undefined:
        printHelp();
        break;
    default:
        console.error(`Unknown command: ${subcommand}`);
        printHelp();
        process.exit(1);
}
//# sourceMappingURL=cli.js.map