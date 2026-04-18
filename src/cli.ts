#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { z } from 'zod';
import { ResearchOrchestrator } from './orchestrator.js';
import { ExperimentMemory } from './memory.js';
import { Cache } from './cache.js';
import { routeTask } from './router.js';
import { BUILT_IN_TEMPLATES, getTemplate, listTemplates } from './templates.js';
import { exportRun } from './export.js';
import type { ResearchGoal, ModelabConfig, ExportFormat, ExperimentArm } from './types.js';

const CONFIG_PATH = join(homedir(), '.modelab', 'config.json');
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Config Schema ──────────────────────────────────────────────────────────

const ModelProviderEnum = z.enum(['openai', 'anthropic', 'ollama', 'openrouter', 'minimax', 'groq', 'gemini', 'perplexity']);

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

function loadConfig(): ModelabConfig {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config not found at ${CONFIG_PATH}`);
    console.error('Run: modelab config --init');
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const parsed = ConfigSchema.parse(raw);
  // Add defaults for missing fields
  for (const [key, model] of Object.entries(parsed.models)) {
    (model as Record<string, unknown>).costPerMillionInput ??= 0;
    (model as Record<string, unknown>).costPerMillionOutput ??= 0;
  }
  return parsed as unknown as ModelabConfig;
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
  modelab history                         Show experiment history
  modelab best [--goal-id <id>]           Show best result
  modelab templates                        List built-in prompt templates
  modelab export <run-id> --format md     Export a past run
  modelab config --init                   Create default config
  modelab config --list                   Show current config
  modelab cache --clear                   Clear the result cache
  modelab route --task <text>             Show model routing decision
  modelab lessons [--goal-id <id>]        Show what the system learned across runs
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

EXAMPLES
  modelab run --goal "What causes migraines?" --threshold 8
  modelab run --goal "Review my API design" --template code-review --arms balanced,coding
  modelab run --goal "Compare Postgres vs DynamoDB" --template compare --arms balanced,reasoning
  modelab export run-abc123 --format html --output report.html

ENVIRONMENT
  OPENAI_API_KEY        OpenAI / Groq / OpenRouter models
  ANTHROPIC_API_KEY     Anthropic models
  MINIMAX_API_KEY       MiniMax models
  GROQ_API_KEY          Groq models (free fast inference)
  GEMINI_API_KEY        Google Gemini models
  PERPLEXITY_API_KEY    Perplexity models
`.trim());
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdLessons(args: string[]) {
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

async function cmdRun(args: string[]) {
  const config = loadConfig();
  const memory = new ExperimentMemory();
  const cache = !args.includes('--no-cache') ? new Cache(CACHE_TTL) : undefined;

  // Parse args
  const goalText = extractArg(args, '--goal') ?? '';
  const maxIterations = parseInt(extractArg(args, '--iterations') ?? '3', 10);
  const qualityThreshold = parseFloat(extractArg(args, '--threshold') ?? '7.0');
  const templateId = extractArg(args, '--template');
  const format = (extractArg(args, '--format') ?? 'md') as ExportFormat;
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

  console.log(`\n🌑 modelab — ${templateName} mode`);
  console.log(`   Question: ${goalText}`);
  console.log(`   Models: ${armModels.join(', ')}`);
  console.log(`   Threshold: ${qualityThreshold}/10 | Iterations: ${maxIterations}\n`);

  const goalId = `goal-${Date.now()}`;
  const arms: ExperimentArm[] = armModels.map((model, i) => ({
    id: `${model}-arm-${i + 1}`,
    name: `${model} (${config.models[model].provider})`,
    promptTemplate,
    model,
  }));

  const goal: ResearchGoal = {
    id: goalId,
    question: goalText,
    goal: goalText,
    qualityThreshold,
    maxIterations,
    arms,
  };

  // Streaming state
  const activeStreams = new Map<string, string>();

  const orchestrator = new ResearchOrchestrator({
    models: config.models,
    budget: config.budget,
    evalModel: config.evalModel,
    parallelism: config.parallelism,
    memory,
    cache,
    onStream: useStream
      ? (armName: string, chunk: string) => {
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
    onProgress: (msg: string) => {
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
    if (log.bestResult.output.length > 800) console.log(`\n... (${log.bestResult.output.length - 800} more chars)`);
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

async function cmdHistory(args: string[]) {
  const memory = new ExperimentMemory();
  const goalId = extractArg(args, '--goal-id');

  const results = memory.getHistory(goalId ?? undefined);
  if (results.length === 0) {
    console.log('No experiments found. Run: modelab run --goal "..."');
  } else {
    console.log(`\n📜 History (${Math.min(results.length, 20)} most recent)\n`);
    const seen = new Set<string>();
    for (const r of results.slice(0, 20)) {
      if (seen.has(r.runId)) continue;
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

async function cmdBest(args: string[]) {
  const memory = new ExperimentMemory();
  const goalId = extractArg(args, '--goal-id');

  if (!goalId) {
    const all = memory.getHistory();
    if (all.length === 0) { console.log('No results.'); memory.close(); return; }
    // Find best overall
    const best = all.reduce((b, r) => (r.score !== null && (!b || r.score > (b.score ?? 0)) ? r : b), all[0] as { output: string; score: number | null; armId: string; costUsd: number; timestamp: string });
    printBest(best);
  } else {
    const best = memory.getBest(goalId);
    if (!best) { console.log(`No best result for "${goalId}".`); }
    else printBest(best);
  }
  memory.close();

  function printBest(r: { output: string; score: number | null; armId: string; costUsd: number; timestamp: string }) {
    console.log(`\n🏆 Best for "${r.armId}" — score ${r.score ?? 'N/A'}/10`);
    console.log(`${'─'.repeat(60)}`);
    console.log(r.output.slice(0, 1000));
    if (r.output.length > 1000) console.log(`\n... (${r.output.length - 1000} more chars)`);
    console.log(`${'─'.repeat(60)}`);
  }
}

function cmdConfig(args: string[]) {
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

function cmdTemplates(args: string[]) {
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

function cmdExport(args: string[]) {
  const runId = args.find(a => !a.startsWith('--'));
  const format = (extractArg(args, '--format') ?? 'md') as ExportFormat;
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
    status: 'completed' as const,
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
  } else {
    console.log(content);
  }

  memory.close();
}

function cmdRoute(args: string[]) {
  const task = extractArg(args, '--task') ?? 'hello world';
  const config = loadConfig();
  const routed = routeTask(task, config.models);
  console.log(`\nTask: "${task}"`);
  console.log(`Routed to: ${routed.model} (${routed.provider})`);
  console.log(`Reasoning: ${routed.reasoning}`);
}

function cmdCache(args: string[]) {
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
  case 'run':       cmdRun(subArgs);       break;
  case 'history':   cmdHistory(subArgs);   break;
  case 'best':      cmdBest(subArgs);      break;
  case 'config':    cmdConfig(subArgs);     break;
  case 'templates': cmdTemplates(subArgs); break;
  case 'export':    cmdExport(subArgs);    break;
  case 'route':     cmdRoute(subArgs);     break;
  case 'cache':     cmdCache(subArgs);     break;
  case 'lessons':   cmdLessons(subArgs);   break;
  case '--help':
  case '-h':
  case undefined:   printHelp();           break;
  default:
    console.error(`❌ Unknown command: ${subcommand}`);
    printHelp();
    process.exit(1);
}

function extractArg(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
