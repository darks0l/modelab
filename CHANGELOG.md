# Changelog

All notable changes to this project are documented in this file.

## v0.5.0

- feat: learned routing now runs by default — `modelab run` without `--arms` calls `routeTaskV2` to auto-select the top 2 models using performance profiles + task type + history, instead of defaulting to the first 2 models
- feat: auto-routing decision is printed before the run — shows task type, complexity, routing reasoning, and the keyword-router fallback for comparison
- fix: `routeTask` was imported but never called in the orchestrator — the orchestrator receives pre-built arms from CLI; routing happens at the CLI layer which now uses routing_v2
- fix: Ollama embedding IP updated to 192.168.68.73 (current Ollama server)
- docs: standard GitHub treatment — DARKSOL banner, badges (npm version, license, platform, node >=18), "Built by DARKSOL 🌑" subheading, footer

## v0.4.3

- fix: routing_v2 scope issue — lessonEngine.getActiveAdjustments/resolveAdjustments now called in correct function scope (was hoisted to top-level module scope)
- feat: routing_v2 reads lesson_engine adjustments — learned router_adjustments from SQLite are now applied to model scores in routeTaskV2

## v0.4.2

- fix: cli.ts — goal possibly undefined bug in cmdRecall (nullish coalescing fix)
- fix: orchestrator.ts — wrong import path for estimateComplexity (complexity.ts, not lesson_engine.ts)
- feat: orchestrator self-iteration hook — calls lessonEngine.updateProfiles() + processRunLesson() after each run; stores run embeddings via embeddingStore
- feat: modelab recall CLI — semantic search across run results and lessons with relevance scoring

## v0.4.1

- fix: TF-IDF blob round-trip — TfIdfVector.fromBlob() for proper deserialization (was returning null on read-back)
- fix: task type inference — REASON_KEYWORDS now catches 'explain why' and general reasoning terms; GLM model mentions still trigger reasoning

## v0.4.0

- feat: lesson_engine — actionable self-iteration closes the loop: run → score → apply router adjustment → next run uses adjusted behavior
- feat: model_profiles table — per-model avg_score, avg_latency_ms, avg_cost_usd, strengths[], weaknesses[]; updated after each run
- feat: router_adjustments table — score_delta, weight_boost, temp_override adjustments written by scorer; applied before each routing decision
- feat: applied_lessons table — records every lesson that was parsed into an actual system change; tracks effectiveness score
- feat: embedding_store — semantic memory with TF-IDF fallback vectors stored in SQLite; supports run and lesson embeddings
- feat: routing_v2 — learned routing that uses model_profiles + task type + active adjustments instead of keyword matching
- feat: campaign layer — multi-run research campaigns with synthesize/report; campaign orchestrator coordinates multi-run studies
- feat: complexity.ts — task complexity profiler (length, question marks, structure heuristics → 1-10 score)

## v0.3.11

- feat: GLM-5.0 router keywords (`glm`, `glm-5`, `glm5`, `智谱`, `zhipu`)
- feat: cross-run learning — `outputPreview` and `outputTruncated` stored in ExperimentResult, cache, and memory DB
- feat: cross-run learning — LCM Memory v2 with iteration summaries, run summaries, and cross-iteration context injection
- fix: bin entry for npm publish (fix-bin.js script, ./bin/modelab.js wrapper)
- docs: README overhaul for v0.3 — research OS positioning, all features documented

## v0.3.10

- feat: LCM memory v2 — iteration summaries, run summaries, cross-run persistence
- feat: scorer handles optional sub-fields (clarity/correctness/completeness)
- feat: new CLI commands — `modelab experiments` (all runs summary) and `modelab review <run-id>` (detailed run view)
- fix: iteration_context template variable bug

## v0.3.9

- feat: add GLM 5.1 model support

## v0.3.8

- feat: TTFT latency stats in run summaries, reports, and comparison table

## v0.3.7

- feat: proactive rate-limit backoff via RateLimitTracker

## v0.3.6

- feat: replace length/4 token estimation with tiktoken gpt2 encoder

## v0.3.5

- feat: enforce structured JSON output in scorer with Zod validation + retry on parse failure
- feat: scoreError field, score cache, pre-check cost guard

## v0.3.4

- feat: retry+timeout on all API calls, full SHA-256 cache hash, error logging, cache entry modelKey field

## v0.3.3

- feat: cross-iteration learning — summarize + inject prior lessons into prompts

## v0.3.2

- fix: bin shebang for npm publish

## v0.3.1

- fix: cross-platform bin entry

## v0.3.0

- feat: cross-iteration learning — summarize + inject prior lessons into prompts

## v0.2.2

- fix: bin shebang for npm publish

## v0.2.1

- fix: cross-platform bin entry

## v0.2.0

- feat: streaming responses
- feat: cache system with SHA-256 content hashing
- feat: export functionality
- feat: prompt templates
- feat: 8 provider support
- feat: comparison table in reports

## v0.1.0

- Initial release — autonomous research agent SDK
- Parallel experiment arms with configurable parallelism
- Multi-model routing (OpenAI, Anthropic, Ollama, OpenRouter)
- Complexity-based task routing: coding / reasoning / quick / balanced
- LLM judge evaluator — structured rubric scoring 0–10
- SQLite-backed experiment memory: log, history, best result, avg score, spend tracking
- Budget guards: per-run and per-experiment cost caps
- Quality threshold early stopping
- CLI: run, history, best, config, route
- Default config generator (`modelab config --init`)
- Prompt template variables: `{{question}}`, `{{goal}}`, custom vars
