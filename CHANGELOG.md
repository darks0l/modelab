# Changelog

All notable changes to this project are documented in this file.

## v0.3.7

- feat: LCM memory v2 — iteration summaries, run summaries, cross-run persistence
- feat: scorer handles optional sub-fields (clarity/correctness/completeness)
- feat: new CLI commands — `modelab experiments` (all runs summary) and `modelab review <run-id>` (detailed run view)
- fix: iteration_context template variable bug

## v0.3.6

- feat: add GLM 5.1 model support

## v0.3.5

- feat: TTFT latency stats in run summaries, reports, and comparison table

## v0.3.4

- feat: proactive rate-limit backoff via RateLimitTracker

## v0.3.3

- feat: replace length/4 token estimation with tiktoken gpt2 encoder

## v0.3.2

- GLM 5.1 audit spawned (in-repo)

## v0.3.1

- feat: enforce structured JSON output in scorer with Zod validation + retry on parse failure
- feat: scoreError field, score cache, pre-check cost guard

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
