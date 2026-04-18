import type { ModelConfig } from './types.js';
/**
 * Simple LLM judge — sends output + question to a configured eval model
 * and parses a 0–10 score from the response.
 *
 * Prompt: structured rubric asking the model to score on
 *   clarity (0–3), correctness (0–4), completeness (0–3)
 */
export declare function evaluate(output: string, question: string, evalModel: ModelConfig): Promise<number>;
export declare function callModel(config: ModelConfig, prompt: string): Promise<string>;
//# sourceMappingURL=evaluator.d.ts.map