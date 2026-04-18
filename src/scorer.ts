import type { ModelConfig } from './types.js';
import { callModel } from './evaluator.js';

export interface ScoreResult {
  score: number;
  reasoning: string;
  clarity: number;
  correctness: number;
  completeness: number;
  /** Set when scoring/parsing fails — score will be null in this case */
  error?: string | null;
}

const RUBRIC = `Score the following answer to the question.\n\nQuestion: {{question}}\n\nAnswer:\n{{answer}}\n\nYou are an impartial evaluator. Score on three dimensions:\n- Clarity (0-3): Is the answer clear, well-organized, and easy to follow?\n- Correctness (0-4): Is the answer factually/reasoningly sound?\n- Completeness (0-3): Does it fully address all parts of the question?\n\nRespond ONLY with a JSON object with this exact structure:\n{"score": <0-10>, "reasoning": "<1-2 sentences>", "clarity": <0-3>, "correctness": <0-4>, "completeness": <0-3>}\n\nReturn only the JSON. No markdown, no explanation.`;

/** Score cache — pure function of (question + first 500 chars of output) */
const scoreCache = new Map<string, ScoreResult>();

/**
 * Evaluate a model output against a question using an LLM judge.
 * Returns a structured ScoreResult with rubric breakdown.
 * Caches results to avoid double LLM calls on repeated (question, output) pairs.
 */
export async function scoreOutput(
  output: string,
  question: string,
  evalModel: ModelConfig
): Promise<ScoreResult> {
  // Cache key: hash of question + first 500 chars of output (stable, fast)
  const cacheKey = `${question}\x00${output.slice(0, 500)}`;
  const cached = scoreCache.get(cacheKey);
  if (cached) return cached;

  const prompt = RUBRIC
    .replace('{{question}}', question)
    .replace('{{answer}}', output.length > 4000 ? output.slice(0, 4000) + '\n[truncated]' : output);

  try {
    const response = await callModel(evalModel, prompt);
    const parsed = parseScoreResponse(response);
    scoreCache.set(cacheKey, parsed);
    return parsed;
  } catch (err) {
    const errorResult: ScoreResult = {
      score: 0,
      reasoning: 'Scoring unavailable',
      clarity: 0,
      correctness: 0,
      completeness: 0,
      error: err instanceof Error ? err.message : String(err),
    };
    scoreCache.set(cacheKey, errorResult);
    return errorResult;
  }
}

export function clearScoreCache(): void {
  scoreCache.clear();
}

export function getScoreCacheSize(): number {
  return scoreCache.size;
}

function parseScoreResponse(raw: string): ScoreResult {
  // Try to extract JSON from markdown code blocks or raw text
  const jsonMatch = raw.match(/```json\s*(\{.*?\})\s*```|(\{.*?\})/s);
  let jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[2]) : raw;

  // Try to find JSON object in the raw text
  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    jsonStr = jsonStr.slice(start, end + 1);
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      score: Math.max(0, Math.min(10, Number(parsed.score) || 0)),
      reasoning: String(parsed.reasoning ?? ''),
      clarity: Math.max(0, Math.min(3, Number(parsed.clarity) || 0)),
      correctness: Math.max(0, Math.min(4, Number(parsed.correctness) || 0)),
      completeness: Math.max(0, Math.min(3, Number(parsed.completeness) || 0)),
    };
  } catch {
    // Fallback: try to find a score number in the text
    const scoreMatch = raw.match(/"score"\s*:\s*([0-9.]+)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
    return {
      score: Math.max(0, Math.min(10, score)),
      reasoning: raw.slice(0, 100),
      clarity: 0,
      correctness: 0,
      completeness: 0,
    };
  }
}
