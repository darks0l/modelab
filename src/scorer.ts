import type { ModelConfig } from './types.js';
import { callModel } from './evaluator.js';

export interface ScoreResult {
  score: number;
  reasoning: string;
  clarity: number;
  correctness: number;
  completeness: number;
}

const RUBRIC = `Score the following answer to the question.

Question: {{question}}

Answer:
{{answer}}

You are an impartial evaluator. Score on three dimensions:
- Clarity (0-3): Is the answer clear, well-organized, and easy to follow?
- Correctness (0-4): Is the answer factually/reasoningly sound?
- Completeness (0-3): Does it fully address all parts of the question?

Respond ONLY with a JSON object with this exact structure:
{"score": <0-10>, "reasoning": "<1-2 sentences>", "clarity": <0-3>, "correctness": <0-4>, "completeness": <0-3>}

Return only the JSON. No markdown, no explanation.`;

/**
 * Evaluate a model output against a question using an LLM judge.
 * Returns a structured ScoreResult with rubric breakdown.
 */
export async function scoreOutput(
  output: string,
  question: string,
  evalModel: ModelConfig
): Promise<ScoreResult> {
  const prompt = RUBRIC
    .replace('{{question}}', question)
    .replace('{{answer}}', output.length > 4000 ? output.slice(0, 4000) + '\n[truncated]' : output);

  try {
    const response = await callModel(evalModel, prompt);
    const parsed = parseScoreResponse(response);
    return parsed;
  } catch (err) {
    console.warn('[modelab:scorer] scoring failed:', err);
    return { score: 0, reasoning: 'Scoring unavailable', clarity: 0, correctness: 0, completeness: 0 };
  }
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
