import type { ModelConfig } from './types.js';
export interface ScoreResult {
    score: number;
    reasoning: string;
    clarity: number;
    correctness: number;
    completeness: number;
}
/**
 * Evaluate a model output against a question using an LLM judge.
 * Returns a structured ScoreResult with rubric breakdown.
 */
export declare function scoreOutput(output: string, question: string, evalModel: ModelConfig): Promise<ScoreResult>;
//# sourceMappingURL=scorer.d.ts.map