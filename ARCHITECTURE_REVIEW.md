# modelab Architecture Review

**Date:** 2026-04-19
**Version reviewed:** v0.3.11
**Context:** Pre-v1.0 pause for architectural reflection. DARKSOL internal tool.

---

## 1. What Works Well

### The Core Loop
The parallel-arm iteration loop is the heart of modelab and it's solid:
- Multiple model strategies run simultaneously per iteration
- Quality threshold provides early stopping
- Budget guards prevent runaway spend
- Temperature sweeps expand into per-variant arms cleanly
- Concurrency via Promise.allSettled with configurable parallelism

This is a well-designed experiment execution engine. The timeout/retry logic in `evaluator.ts`, the rate-limit tracker, and the Zod-validated scorer are all production-quality components.

### LCM Memory v2 — SQLite Persistence
Storing every experiment result, iteration summary, and run summary in SQLite is the right call. SQLite is zero-configuration, fast, and survives across process restarts. The schema — `experiments`, `iteration_summaries`, `run_summaries` — covers the right entities. The `getContextForIteration` cross-run learning query is the most sophisticated piece of the system and it's genuinely useful: it pulls historical performance by arm family, infers per-model temperature preferences, and generates actionable guidance text.

### Cache System
SHA-256 content-addressed cache with model+arm key is correct and necessary. The corruption handling (starts fresh on bad JSON) is defensive and right.

### Token Counting
Tiktoken replacement was a real improvement. `length/4` was broken for multilingual content. The actual cost tracking and token counting now matches what the API charges.

### TTFT Latency Tracking
Captured correctly, stored in DB, shown in comparison tables, used for `latencyTargetMs` arm filtering. This is a meaningful signal for latency-sensitive applications.

### CLI Completeness
`run`, `history`, `best`, `experiments`, `review`, `templates`, `export`, `route`, `cache`, `config` — the CLI surface is complete and covers the actual workflow of a researcher using this tool.

---

## 2. Critical Gaps for True Autonomous Operation

modelab calls itself an "autonomous AI research OS" but the autonomy is thin. Here's what's actually missing:

### No Autonomous Loop
`modelab run` is a batch job. You give it a question, it runs some experiments, it produces a report. It does not:
- Propose follow-up experiments based on results
- Detect that an approach failed and pivot strategy
- Set up a campaign of related experiments across a research question
- Report findings in a way that feeds into the next research step

A human must interpret the output and decide what to try next. This is a research **tool**, not a research **agent**.

### No Self-Modification
The "cross-run learning" only affects prompt context — it writes text into `{{iteration_context}}`. This means:
- The guidance is advisory only and can be ignored by the model
- Nothing in the system actually changes behavior based on outcomes
- There's no mechanism to say "the prompt strategy for arm X is clearly wrong, rewrite it"
- The orchestrator cannot restructure an experiment mid-run

The system stores lessons but doesn't learn from them in any actionable way.

### No Semantic Memory
SQLite stores structured data but you cannot ask "what have we learned about coding tasks across all runs?" The `getModelInsights()` function aggregates stats but there's no search, no similarity matching, no ability to find "runs similar to this one."

### No Report Generation Beyond Summaries
`experiments` and `review` show tables and structured data. There's no natural-language insight generation — no "the key finding is X because Y." The `lesson` field in iteration summaries is auto-generated boilerplate, not genuine insight.

### No Multi-Round Campaign Management
Real research involves a sequence of related experiments across days or weeks. modelab has no concept of a "campaign" or "research project" that spans multiple runs with evolving goals.

---

## 3. Self-Iteration — Does the System Actually Improve Itself?

**Short answer: No, not really.**

The "cross-run learning" system is the most sophisticated attempt at self-improvement and it has fundamental limitations:

### What it does:
- Pulls prior iteration summaries and injects them as text into the prompt
- Generates guidance strings like "prefer claude-sonnet for this arm family"
- Detects score trends (improving/declining/stable)
- Warns about underperforming arm families

### What it doesn't do:
- Change any modelab code or configuration
- Modify the prompt template strategy for future runs
- Detect that a model is systematically misbehaving and exclude it
- Learn from failed runs (runs that error out) and avoid that pattern
- Propose new arm configurations based on what failed

### The fundamental problem:
The learning is **declarative text** injected into prompts. The model reading that context can ignore it, misunderstand it, or be confused by it. There's no closed loop where the system says "iteration 3 failed, therefore in iteration 4 we do X instead of Y" at the execution level.

**Verdict:** Cross-run learning produces marginally better results by reminding the model what was tried before. But it cannot fix broken prompt strategies, cannot adapt the experiment design, and cannot learn from accumulated data in any systematic way.

---

## 4. Memory — Is LCM Memory v2 Sufficient?

### What's good:
- Stores every experiment result with full output, tokens, cost, latency, score
- Iteration summaries with lessons
- Run-level summaries
- Cross-run query support (getHistory, getBest, getLessons, getModelInsights)
- Trend detection, per-arm-model performance tracking

### What's missing:

**Semantic search.** You cannot ask "find all experiments about consensus mechanisms" or "what did we learn about prompt X across all runs?" The data is in SQLite but there's no way to search it by meaning.

**Insight aggregation.** `getModelInsights()` gives per-(armFamily, taskType) stats but there's no function that says "given this new question, what should we try and why?" The insights are descriptive, not prescriptive.

**Data eviction.** The database grows forever. No TTL, no rollup of old runs into summaries, no way to archive experiments.

**Structured query interface.** You can't ask "show me all runs where best_score < 5 and the model was claude-sonnet." The `getHistory()` function just returns raw rows.

**Verdict:** LCM Memory v2 is sufficient for basic experiment persistence and simple aggregation. It's not sufficient for a system that needs to learn from history in any sophisticated way. The gap is semantic search and actionable insight generation.

---

## 5. Model Routing — Is the Keyword Router Good Enough?

**No. It's a proof-of-concept that needs to be replaced.**

### Current state:
Keyword regex matching against `CODE_KEYWORDS`, `REASON_KEYWORDS`, `QUICK_KEYWORDS`. Fragile, English-centric, requires adding keywords manually for each new model/topic.

### What's missing:

**No cost-quality-latency optimization.** Given a task and a budget, the router should be able to say "use gpt-4o-mini for this query because it's 10x cheaper than claude-sonnet and the quality difference is negligible for this task type." Currently there's no such logic.

**No learned routing.** The router doesn't learn from experiment outcomes. If claude-sonnet consistently beats gpt-4o-mini on reasoning tasks in your experiments, that information is not used to improve routing.

**No task difficulty estimation.** "What is 2+2?" and "Prove P=NP" are both "reasoning" tasks by keyword detection but need completely different model capabilities.

**No provider-specific handling.** Different providers have different rate limits, latencies, and failure modes. The router doesn't account for this.

**What a real router needs:**
1. Embed the question and select the model that historically performed best on similar questions
2. Optimize for cost/quality/latency tradeoffs specified by the user
3. Be aware of provider availability and current load
4. Update routing decisions based on accumulated experiment outcomes
5. Handle multilingual content properly (the Chinese keyword detection was bolted on)

**Verdict:** The keyword router is fine for v0.3 prototype purposes but is a significant gap for v1.0. A production router needs learned embeddings or at minimum a proper task taxonomy with cost/quality attributes per model.

---

## 6. Execution Model — Agent or Research Engine?

Currently modelab is a **research engine that outputs reports**. You ask a question, it generates answers, scores them, iterates. The output is a structured report with comparison tables.

**The question is: should modelab be an agent?**

### Arguments for staying a research engine:
- Research is inherently human-driven; autonomous agents that "do research" hallucinate and lose coherence
- A report-generating tool is predictable and auditable
- The current design is simpler to test and reason about
- You can run it in batch and process reports later

### Arguments for becoming an agent:
- The "autonomous research OS" branding implies autonomy
- A human can't be running `modelab run` every 30 minutes to check progress
- Real research involves conditional logic: "if X fails, try Y; if Y fails, try Z"
- A research agent could run a multi-day campaign, summarize findings, and trigger new experiments

### The honest answer:
**modelab should remain a research engine but with a thin agent wrapper.**

The orchestrator/core is sound as a batch engine. The agent wrapper should handle:
- Running multiple experiments in sequence
- Monitoring results and deciding when to stop or pivot
- Generating natural-language summaries of findings
- Triggering follow-up experiments based on results

This is essentially a "research campaign manager" layer on top of the batch engine.

---

## 7. What Would v1.0 Look Like?

Concrete next steps, in priority order:

### P0 — Fix the broken self-iteration
The current cross-run learning is advisory text in prompts. For v1.0 it needs to be **actionable**:
- If an arm scores < 4/10, mark it as failed and don't retry the same config
- Store per-arm temperature + model preferences and actually apply them in routing
- Add a `strategy` field to arms: if iteration 1 fails, iteration 2 uses a different prompt strategy automatically

### P1 — Semantic memory layer
Add vector search (sqlite-vss or just an embeddings table) so you can ask:
- "Find all experiments similar to this question"
- "What have we learned about X across all runs?"
- "Which model performed best on Y task type?"

This transforms memory from a log into a knowledge base.

### P1 — Learned routing
Replace keyword regex with:
- A small embedding model for question similarity
- Historical performance lookup: "for questions similar to this, which model has the highest average score?"
- Cost/quality/latency optimization when routing

### P2 — Research campaign mode
Add a `modelab campaign --goal "research topic" --max-runs 10` mode that:
- Runs experiments sequentially
- After each run, generates a brief natural-language summary
- Decides whether to continue, pivot, or conclude
- Produces a final research report at the end

### P2 — Report generation
The current "report" is a markdown table. For v1.0:
- Natural language key findings
- Confidence levels on conclusions
- Recommendations for next steps
- Comparison with prior research on the same topic

### P3 — Multi-user / team support
Currently it's single-user (SQLite in home dir). For team use:
- Shared experiment database
- User attribution on runs
- Access control on expensive experiments

### P3 — Web/API server mode
`modelab serve` — run as a server that accepts research goals via HTTP, executes campaigns, streams progress, and exposes a web UI for browsing experiments.

---

## Summary

| Dimension | Assessment |
|-----------|------------|
| Core experiment loop | ✅ Production quality |
| Persistence (SQLite) | ✅ Solid, well-indexed |
| Cross-run learning | ⚠️ Advisory only, needs to be actionable |
| Self-modification | ❌ No systematic self-improvement |
| Semantic memory | ❌ Need vector search |
| Model routing | ⚠️ Keyword prototype, needs learned replacement |
| Execution model | ⚠️ Batch engine in an agent's clothing |
| Autonomous operation | ❌ Limited — needs a campaign manager layer |

modelab v0.3 is a well-built **experiment execution engine** with good fundamentals. The architecture choices (SQLite, parallel arms, structured scoring, cache) are all correct. The gap is that it's not yet an **autonomous research OS** — it executes experiments but doesn't drive research campaigns, doesn't learn from failures systematically, and doesn't generate genuine insights.

The path to v1.0 is: make self-iteration actionable, add semantic memory, replace keyword routing with learned routing, and add a campaign manager layer on top of the existing orchestrator. The core is good enough to build on.
