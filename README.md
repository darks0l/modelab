# modelab 🌑 — Autonomous AI Research OS

**modelab** is a CLI and SDK for running parallel AI research experiments. Ask a question, spin up multiple model strategies simultaneously, score their outputs, cache results, export reports, and build on what you learn. Used internally at DARKSOL for systematic research.

---

## Install

```bash
npm install modelab
modelab config --init   # creates ~/.modelab/config.json
```

---

## Quick Start

```bash
# Ask a question, run 2 models in parallel, score results
modelab run --goal "What causes migraines and how do the best treatments work?"

# Use a built-in template
modelab run --goal "Review my REST API design" --template code-review

# Compare specific models
modelab run --goal "Explain ZK rollup economics" --arms balanced,reasoning

# Export to HTML report
modelab run --goal "Compare Postgres vs DynamoDB for a startup" --format html --output report.html
```

---

## What's new in v0.3

- **LCM Memory v2** — iteration/run summaries with cross-run persistence and cross-iteration learning
- **Tiktoken encoding** — accurate token counting with GPT-2 vocab tokenizer
- **Proactive rate-limit backoff** — RateLimitTracker avoids hitting provider limits
- **TTFT latency stats** — time-to-first-token tracked per arm, reported in summaries
- **Experiments view** — `modelab experiments --sort score|cost|date` for all runs at a glance
- **Review command** — `modelab review <run-id>` for deep-dive latency + lesson breakdown
- **Streaming output** — watch tokens arrive in real-time with `--stream`
- **Hash-based caching** — skip re-runs of the same question+model+arm
- **Multi-format export** — `json`, `md`, `html` with dark/light themes
- **10 model providers** — OpenAI, Anthropic, Ollama, Groq, Gemini, Perplexity, MiniMax, OpenRouter, GLM 5.1, DeepSeek
- **7 built-in templates** — research, code-review, architecture, bug-hunt, compare, quick-answer, creative
- **Structured scorer** — rubric breakdown with graceful optional sub-fields

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

```bash
modelab templates          # list all templates
modelab run --goal "..." --template research
```

---

## CLI Commands

```bash
modelab run --goal "..." [--iterations N] [--threshold N] [--arms m1,m2] [--template id] [--format json|md|html] [--output path] [--stream] [--no-cache]
                         Run a research experiment
modelab history            Show experiment history with scores and costs
modelab best [--goal-id]  Show best result for a goal
modelab templates         List built-in prompt templates
modelab export <run-id>   Re-export a past run to json/md/html
modelab cache --clear     Clear the result cache
modelab route --task "..."  Show model routing decision
modelab config --init     Create ~/.modelab/config.json
modelab config --list     Show current config
```

---

## Config

`~/.modelab/config.json`:

```json
{
  "models": {
    "fast":      { "provider": "openai",   "model": "gpt-4o-mini",            "costPerMillionInput": 0.15,  "costPerMillionOutput": 0.60 },
    "balanced":  { "provider": "anthropic", "model": "claude-sonnet-4-6",       "costPerMillionInput": 3,     "costPerMillionOutput": 15 },
    "reasoning": { "provider": "openai",   "model": "o1",                      "costPerMillionInput": 15,    "costPerMillionOutput": 60 },
    "coding":    { "provider": "ollama",    "model": "qwen3-coder",             "baseUrl": "http://localhost:11434" },
    "groq":      { "provider": "groq",      "model": "llama-3.3-70b-versatile",  "costPerMillionInput": 0,     "costPerMillionOutput": 0 },
    "gemini":    { "provider": "gemini",    "model": "gemini-2.0-flash",         "costPerMillionInput": 0,     "costPerMillionOutput": 0 }
  },
  "evalModel": "balanced",
  "budget": { "maxPerRun": 2.0, "maxPerExperiment": 0.5, "trackCosts": true },
  "parallelism": 3
}
```

---

## Model Routing

Tasks are classified by keyword heuristics and routed to the best-fit model:

| Task | Keywords | Routes to |
|------|----------|-----------|
| coding | code, refactor, bug, build, PR | `coding` |
| reasoning | proof, logic, analysis, theorem | `reasoning` |
| quick | quick, summary, what is, define | `fast` |
| default | everything else | `balanced` |

Override with `--arms fast,balanced` or configure explicitly.

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
| `GROQ_API_KEY` | Groq (free fast tier) |
| `GEMINI_API_KEY` | Google Gemini |
| `PERPLEXITY_API_KEY` | Perplexity |

---

## Architecture

```
ResearchOrchestrator
  ├── router.ts      — complexity heuristic → best-fit model
  ├── evaluator.ts   — streaming calls across 8 providers
  ├── scorer.ts      — LLM judge: clarity + correctness + completeness
  ├── orchestrator   — parallel arms, quality gate, budget guard
  ├── memory.ts      — SQLite: ~/.modelab/memory.db
  ├── cache.ts       — SHA-256 hash cache: ~/.modelab/cache.json
  ├── templates.ts   — 7 built-in prompt templates
  └── export.ts      — json / markdown / html reports
```

---

## Built with teeth. 🌑

MIT License
