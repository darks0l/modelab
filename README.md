# modelab

**Autonomous research agent SDK** — iteratively explores questions with strategically routed AI models, parallel experiment arms, and self-evaluation.

Given a research question, modelab runs parallel experiment arms across different models, scores each output, learns from history, and stops when quality or budget thresholds are hit. Built for internal DARKSOL tooling — the kind of agent that runs 3 strategies simultaneously, picks the best, and improves itself over time.

---

## Install

```bash
npm install modelab
```

---

## Quick Start

### 1. Initialize config

```bash
modelab config --init   # creates ~/.modelab/config.json
# Edit the config to set your API keys and model preferences
```

### 2. Run a research goal

```bash
modelab run --goal "What is the most efficient consensus algorithm for high-throughput L2 rollups?" --iterations 3 --threshold 7.5
```

Or use it as a library:

```typescript
import { ResearchOrchestrator } from 'modelab';

const orchestrator = new ResearchOrchestrator({
  models: {
    balanced: { provider: 'anthropic', model: 'claude-sonnet-4-6', costPerMillionInput: 3, costPerMillionOutput: 15 },
    reasoning: { provider: 'openai', model: 'o1', costPerMillionInput: 15, costPerMillionOutput: 60 },
    fast: { provider: 'openai', model: 'gpt-4o-mini', costPerMillionInput: 0.15, costPerMillionOutput: 0.60 },
  },
  budget: { maxPerRun: 2.0, maxPerExperiment: 0.5, trackCosts: true },
  evalModel: 'balanced',
  parallelism: 3,
});

const log = await orchestrator.run({
  id: 'my-goal-1',
  question: 'What is the optimal block time for Ethereum L2s?',
  goal: 'Provide a technically rigorous analysis',
  qualityThreshold: 7.5,
  maxIterations: 3,
  arms: [
    { id: 'arm-1', name: 'reasoning', model: 'reasoning', promptTemplate: '...' },
    { id: 'arm-2', name: 'balanced',   model: 'balanced',   promptTemplate: '...' },
  ],
});

console.log(log.bestResult);
```

---

## Architecture

```
ResearchOrchestrator
  ├── router.ts      — routes tasks to best-fit model (heuristic complexity analysis)
  ├── evaluator.ts   — LLM judge scores outputs 0–10 on rubric
  ├── memory.ts      — SQLite experiment log (persists to ~/.modelab/memory.db)
  └── orchestrator   — main loop: parallel arms → evaluate → log → iterate
```

**Loop per iteration:**
1. Fan out arms in parallel (up to `parallelism` concurrent)
2. Each arm: fill prompt template → call routed model → get output
3. Evaluator scores each output against the research question
4. Results logged to SQLite memory
5. Check quality threshold → stop if reached
6. Check budget → stop if exceeded

---

## Config

`~/.modelab/config.json`:

```json
{
  "models": {
    "fast":     { "provider": "openai",    "model": "gpt-4o-mini",       "costPerMillionInput": 0.15, "costPerMillionOutput": 0.60 },
    "balanced": { "provider": "anthropic",  "model": "claude-sonnet-4-6", "costPerMillionInput": 3,    "costPerMillionOutput": 15 },
    "reasoning":{ "provider": "openai",     "model": "o1",                 "costPerMillionInput": 15,   "costPerMillionOutput": 60 },
    "coding":   { "provider": "ollama",     "model": "qwen3-coder",        "baseUrl": "http://localhost:11434", "costPerMillionInput": 0, "costPerMillionOutput": 0 }
  },
  "evalModel": "balanced",
  "budget": { "maxPerRun": 2.0, "maxPerExperiment": 0.5, "trackCosts": true },
  "parallelism": 3
}
```

### Model routing

| Task type | Keywords | Preferred model |
|-----------|----------|-----------------|
| coding | code, refactor, bug, build, repo | `coding` > `balanced` |
| reasoning | reason, proof, logic, analysis, theorem | `reasoning` > `balanced` |
| quick | quick, small, summary, what is | `fast` > `balanced` |
| default | — | `balanced` |

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `modelab run --goal "..." [--iterations N] [--threshold N] [--arms N]` | Run research experiment |
| `modelab history [--goal-id <id>]` | Show experiment history |
| `modelab best [--goal-id <id>]` | Show best result for a goal |
| `modelab config --init` | Create default config |
| `modelab config --list` | Show current config |
| `modelab route --task "..."` | Show model routing decision |
| `modelab --help` | Show help |

---

## Features

- **Parallel experiment arms** — run multiple strategies simultaneously, pick the best
- **Multi-model routing** — heuristic complexity routing across OpenAI / Anthropic / Ollama
- **LLM self-evaluation** — structured rubric scoring (clarity + correctness + completeness)
- **SQLite memory** — experiment history, best result lookup, average scores, total spend
- **Budget guards** — per-run and per-experiment cost caps
- **Quality gates** — stops early if threshold is reached
- **Graceful degradation** — one arm failing doesn't kill the run
- **Template variables** — `{{question}}`, `{{goal}}`, custom vars per arm
- **Ollama support** — local models with zero API cost

---

## Environment variables

| Variable | Used for |
|----------|----------|
| `OPENAI_API_KEY` | OpenAI / OpenRouter models |
| `ANTHROPIC_API_KEY` | Anthropic models |
| `OLLAMA_HOST` | Ollama base URL (default: `http://localhost:11434`) |

---

## Built with teeth. 🌑

MIT License
