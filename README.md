# modelab 🌑 — Autonomous AI Research OS

> **This is a real research engine, not a demo or toy.** It runs structured experiments against multiple models simultaneously, scores outputs against a rubric, caches results, learns across runs, and produces reports you can actually act on.

modelab is used internally at DARKSOL for systematic research — comparing model strategies, building test suites for prompts, auditing model behavior, and generating reproducible reports.

---

## Install

```bash
npm install modelab
modelab config --init   # creates ~/.modelab/config.json
```

---

## Quick Start

```bash
# Run a research question across 3 model strategies in parallel
modelab run --goal "What causes migraines and what do the best treatments look like?"

# Compare specific models head-to-head
modelab run --goal "Explain ZK rollup economics" --arms balanced,reasoning

# Use a built-in template
modelab run --goal "Review my REST API design" --template code-review

# Watch streaming tokens arrive in real-time
modelab run --goal "Write a生日贺卡" --template creative --stream

# Export to HTML
modelab run --goal "Compare Postgres vs DynamoDB for a startup" --format html --output report.html
```

---

## What's new in v0.4

### Actionable Self-Iteration (lesson_engine)
Previous versions stored "lessons" as advisory notes nobody read. v0.4 closes the loop: after each run, the lesson_engine parses the scorer output, writes actual router adjustments to the DB, and the routing layer applies them before the next run. Score below 4? Model gets a -1 penalty. Score above 8? It gets boosted for that task type. Lessons become config changes — automatically.

### Model Profiles
Every model maintains a performance profile updated after each run: avg_score, avg_latency_ms, avg_cost_usd, strengths[], weaknesses[]. The router reads this, not just keyword matching.

### Semantic Memory (embedding_store)
Run summaries and lessons are embedded using TF-IDF vectors (Ollama nomic-embed-text when available) and stored in SQLite. Query past experiments semantically: `modelab recall "what did we learn about coding tasks?"`

### Learned Routing (routing_v2)
Replaces the keyword router with a performance-based router that considers: model strengths for the task type, historical scores, active adjustments, and similar past runs.

### Campaign Layer
Multi-run research campaigns: `modelab campaign new "My Hypothesis" --runs 10 --synthesize`. Coordinates a series of runs, synthesizes findings, and generates reports.

### Task Complexity Profiling
Goals are analyzed for complexity (question marks, structure, length) before routing. High-complexity tasks get more iterations; low-complexity get faster models.

### LCM Memory v2 — Cross-Run Persistence + Cross-Iteration Learning
Every run writes iteration summaries and full run summaries to SQLite. Before running, modelab loads prior context for the same goal ID — so lessons from last week actually influence today's experiment. The `iteration_context` template variable carries these lessons into new prompts automatically.

### Tiktoken Token Counting
Replaced rough `length/4` estimation with the GPT-2 vocab Tiktoken encoder. Token counts and cost estimates are now accurate to the actual tokenization scheme of the model being used.

### Proactive Rate-Limit Backoff
`RateLimitTracker` tracks 429 responses and their `Retry-After` headers. Before making a call, the system checks whether the endpoint is currently throttled and waits proactively — not just retrying after failure but preventing it.

### TTFT Latency Stats
Time-to-first-token is measured per arm per call and aggregated into p50/p95 stats. These are shown in comparison tables and stored in run logs. Arms can be configured with a `latencyTargetMs` to skip models that are historically slow.

### GLM-5.0 Routing
The keyword router now recognizes `glm`, `glm-5`, `glm5`, `智谱`, `zhipu` and routes to the GLM-5.1 model — enabling research on Chinese-language models and frontier Chinese providers.

### Cross-Run Learning System
- `outputPreview` (first 200 chars) and `outputTruncated` (boolean) stored in DB and cache
- `experiments` command: `modelab experiments --sort score|cost|date` for at-a-glance run history
- `review` command: `modelab review <run-id>` for detailed latency + lesson breakdown

### Structured Scorer with Optional Sub-Fields
The LLM judge returns `{ score, reasoning, clarity?, correctness?, completeness? }`. Sub-fields are optional — the scorer still works if the judge skips them.

---

## CLI Commands

```bash
modelab run --goal "..." [--iterations N] [--threshold N] [--arms m1,m2]
              [--template id] [--format json|md|html] [--output path]
              [--stream] [--no-cache]
              Run a research experiment

modelab experiments [--sort score|cost|date]    View all runs at a glance
modelab review <run-id>                         Deep-dive: latency + lesson breakdown
modelab history                                 Show run history
modelab best [--goal-id]                        Show best result for a goal
modelab templates                               List built-in prompt templates
modelab export <run-id> [--format json|md|html] Re-export a past run
modelab route --task "..."                      Show model routing decision
modelab cache --clear                           Clear the result cache
modelab config --init                           Create ~/.modelab/config.json
modelab config --list                           Show current config
```

---

## Built-in Templates

| Template | Use case |
|----------|----------|
| `research` | Deep multi-perspective research |
| `code-review` | Bugs, security, performance review |
| `architecture` | System design and trade-offs |
| `bug-hunt` | Adversarial failure-mode analysis |
| `compare` | A/B decisions with scoring |
| `quick-answer` | Fast, concise responses |
| `creative` | Brainstorming and ideation |

---

## Model Routing

Tasks are classified by keyword heuristics and routed to the best-fit model:

| Task | Keywords | Routes to |
|------|----------|-----------|
| coding | code, refactor, bug, build, PR, function, class | `coding` |
| reasoning | proof, logic, analysis, theorem, theorem,证明,推理 | `reasoning` |
| glm | glm, glm-5, glm5, 智谱, zhipu | `glm` |
| quick | quick, summary, what is, define, 什么是 | `fast` |
| default | everything else | `balanced` |

Override with `--arms fast,balanced,reasoning` or configure explicitly in config.

---

## Config

`~/.modelab/config.json`:

```json
{
  "models": {
    "fast":      { "provider": "openai",   "model": "gpt-4o-mini",             "costPerMillionInput": 0.15,  "costPerMillionOutput": 0.60 },
    "balanced":  { "provider": "anthropic", "model": "claude-sonnet-4-6",        "costPerMillionInput": 3,     "costPerMillionOutput": 15 },
    "reasoning": { "provider": "openai",   "model": "o1",                       "costPerMillionInput": 15,    "costPerMillionOutput": 60 },
    "coding":    { "provider": "ollama",   "model": "qwen3-coder",              "baseUrl": "http://localhost:11434" },
    "glm":       { "provider": "openai",    "model": "glm-z1-air",                "baseUrl": "https://open.bigmodel.cn/api/paas/v4" },
    "groq":      { "provider": "groq",      "model": "llama-3.3-70b-versatile",  "costPerMillionInput": 0.2,   "costPerMillionOutput": 0.8 }
  },
  "evalModel": "balanced",
  "budget": { "maxPerRun": 2.0, "maxPerExperiment": 0.5, "trackCosts": true },
  "parallelism": 3
}
```

---

## Use as a Library

```typescript
import { ResearchOrchestrator } from 'modelab';

const orch = new ResearchOrchestrator({
  models: {
    balanced: { provider: 'anthropic', model: 'claude-sonnet-4-6', costPerMillionInput: 3, costPerMillionOutput: 15 },
    reasoning: { provider: 'openai', model: 'o1', costPerMillionInput: 15, costPerMillionOutput: 60 },
  },
  budget: { maxPerRun: 2.0, maxPerExperiment: 0.5, trackCosts: true },
  evalModel: 'balanced',
  parallelism: 3,
  onProgress: msg => console.log(msg),
  onArmComplete: r => console.log(`Arm done: ${r.armId} → ${r.score}/10`),
});

const log = await orch.run({
  id: 'my-goal',
  question: 'What is the optimal block time for Ethereum L2s?',
  goal: 'Provide a technically rigorous analysis',
  qualityThreshold: 7.5,
  maxIterations: 3,
  arms: [
    { id: 'arm-1', name: 'balanced', model: 'balanced', promptTemplate: '...' },
    { id: 'arm-2', name: 'reasoning', model: 'reasoning', promptTemplate: '...' },
  ],
});

console.log(log.bestResult);
console.log(`Total cost: $${log.totalCostUsd}`);
```

---

## Environment Variables

| Variable | Provider |
|---------|---------|
| `OPENAI_API_KEY` | OpenAI, Groq, OpenRouter, Perplexity |
| `ANTHROPIC_API_KEY` | Anthropic |
| `MINIMAX_API_KEY` | MiniMax |
| `GROQ_API_KEY` | Groq |
| `GEMINI_API_KEY` | Google Gemini |
| `PERPLEXITY_API_KEY` | Perplexity |

---

## Architecture

```
ResearchOrchestrator
  ├── router.ts         — keyword heuristic → best-fit model (GLM-5.0 aware)
  ├── evaluator.ts      — streaming calls across 10 providers, rate-limit tracking
  ├── scorer.ts         — LLM judge: structured rubric, Zod validation, retry
  ├── orchestrator.ts   — parallel arms, quality gate, budget guard, TTFT tracking
  ├── memory.ts         — SQLite: ~/.modelab/memory.db (LCM Memory v2)
  ├── cache.ts          — SHA-256 hash cache: ~/.modelab/cache.json
  ├── templates.ts     — 7 built-in prompt templates
  └── export.ts         — json / markdown / html reports
```

---

## Built with teeth. 🌑

MIT License
