import type { ModelConfig } from './types.js';
export interface ScoreResult {
    score: number;
    reasoning: string;
    clarity: number;
    correctness: number;
    completeness: number;
    /** Set when scoring/parsing fails — score will be null in this case */
    error?: string | null;
}
/**
 * Evaluate a model output against a question using an LLM judge.
 * Returns a structured ScoreResult with rubric breakdown.
 * Caches results to avoid double LLM calls on repeated (question, output) pairs.
 */
export declare function scoreOutput(output: string, question: string, evalModel: ModelConfig, maxRetries?: number): Promise<ScoreResult>;
export declare function clearScoreCache(): void;
export declare function getScoreCacheSize(): number;
//# sourceMappingURL=scorer.d.ts.map