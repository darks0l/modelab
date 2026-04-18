# Changelog

All notable changes to this project are documented in this file.

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
