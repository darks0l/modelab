import { z } from 'zod';
import type { ModelConfig } from './types.js';
import { callModel } from './evaluator.js';

const ScoreResultSchema = z.object({
  score: z.number().min(0).max(10),
  reasoning: z.string(),
  clarity: z.number().min(0).max(3).optional(),
  correctness: z.number().min(0).max(4).optional(),
  completeness: z.number().min(0).max(3).optional(),
}).required();

export interface ScoreResult {
  score: number;
  reasoning: string;
  clarity?: number;
  correctness?: number;
  completeness?: number;
  /** Set when scoring/parsing fails — score will be 0 in this case */
  error?: string | null;
}

const RUBRIC = `Score the following answer to the question.\n\nQuestion: {{question}}\n\nAnswer:\n{{answer}}\n\nYou are an impartial evaluator. Score on three dimensions:\n- Clarity (0-3): Is the answer clear, well-organized, and easy to follow?\n- Correctness (0-4): Is the answer factually/reasoningly sound?\n- Completeness (0-3): Does it fully address all parts of the question?\n\nIMPORTANT: Respond ONLY with a valid JSON object. No markdown, no explanation, no text outside the JSON. The JSON must have this exact structure:\n{\n  "score": <0-10 number>,\n  "reasoning": "<1-2 sentence explanation>",\n  "clarity": <0-3 integer>,\n  "correctness": <0-4 integer>,\n  "completeness": <0-3 integer>\n}`;

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
  evalModel: ModelConfig,
  maxRetries = 2
): Promise<ScoreResult> {
  // Cache key: hash of question + first 500 chars of output (stable, fast)
  const cacheKey = `${question}\x00${output.slice(0, 500)}`;
  const cached = scoreCache.get(cacheKey);
  if (cached) return cached;

  const prompt = RUBRIC
    .replace('{{question}}', question)
    .replace('{{answer}}', output.length > 4000 ? output.slice(0, 4000) + '\n[truncated]' : output);

  let lastError = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await callModel(evalModel, prompt);
      const parsed = parseScoreResponse(response);
      // Validate with Zod
      const validated = ScoreResultSchema.safeParse(parsed);
      if (validated.success) {
        scoreCache.set(cacheKey, parsed);
        return parsed;
      }
      lastError = `Zod validation failed: ${validated.error.message}`;
      // Add a hint to retry on parse failure
      if (attempt < maxRetries) {
        console.warn(`[modelab:scorer] Validation attempt ${attempt + 1} failed: ${lastError}. Retrying...`);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < maxRetries) {
      await sleep(500 * (attempt + 1));
    }
  }

  // All retries exhausted
  const errorResult: ScoreResult = {
    score: 0,
    reasoning: `Scoring unavailable (validation failed after ${maxRetries + 1} attempts: ${lastError})`,
    clarity: 0,
    correctness: 0,
    completeness: 0,
    error: lastError,
  };
  scoreCache.set(cacheKey, errorResult);
  return errorResult;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function clearScoreCache(): void {
  scoreCache.clear();
}

export function getScoreCacheSize(): number {
  return scoreCache.size;
}

function parseScoreResponse(raw: string): ScoreResult {
  // Try to extract JSON from markdown code blocks or raw text
  const jsonMatch = raw.match(/```json\s*(\{[\s\S]*?\})\s*```|```\s*(\{[\s\S]*?\})\s*```|(\{[\s\S]*?\})/s);
  let jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[2] ?? jsonMatch[3]) : raw;

  // Try to find JSON object in the raw text
  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    jsonStr = jsonStr.slice(start, end + 1);
  }

  const parsed = JSON.parse(jsonStr);
  const score = Math.max(0, Math.min(10, Number(parsed.score) ?? 0));
  const reasoning = String(parsed.reasoning ?? '');
  const clarity = parsed.clarity !== undefined ? Math.max(0, Math.min(3, Number(parsed.clarity))) : undefined;
  const correctness = parsed.correctness !== undefined ? Math.max(0, Math.min(4, Number(parsed.correctness))) : undefined;
  const completeness = parsed.completeness !== undefined ? Math.max(0, Math.min(3, Number(parsed.completeness))) : undefined;

  // Build result object — omit fields entirely when missing so Zod's .required() can reject
  const result: Record<string, unknown> = { score, reasoning };
  if (clarity !== undefined) result.clarity = clarity;
  if (correctness !== undefined) result.correctness = correctness;
  if (completeness !== undefined) result.completeness = completeness;
  return result as Omit<ScoreResult, 'error'>;
}
