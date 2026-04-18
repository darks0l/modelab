// ── Core Types ──────────────────────────────────────────────────────────────

export type ModelProvider = 'openai' | 'anthropic' | 'ollama' | 'openrouter' | 'minimax' | 'groq' | 'gemini' | 'perplexity' | 'glm';

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  costPerMillionInput: number;
  costPerMillionOutput: number;
  maxTokens?: number;
  temperature?: number;
  /** Streaming callback — called with each chunk as it arrives */
  stream?: (chunk: string) => void;
  /** Request JSON-mode response where supported (OpenAI, Anthropic, Groq, OpenRouter) */
  jsonMode?: boolean;
}

export interface ModelabConfig {
  models: Record<string, ModelConfig>;
  budget: {
    maxPerRun: number;
    maxPerExperiment: number;
    trackCosts: boolean;
  };
  evalModel: string;
  parallelism: number;
  cache?: {
    enabled: boolean;
    ttlMs?: number;
  };
  export?: {
    defaultFormat: 'json' | 'md' | 'html';
    outputDir?: string;
  };
}

// ── Experiment Types ─────────────────────────────────────────────────────────

export interface ResearchGoal {
  id: string;
  question: string;
  goal: string;
  qualityThreshold: number;
  maxIterations: number;
  arms: ExperimentArm[];
}

export interface ExperimentArm {
  id: string;
  name: string;
  /** Mustache-style template: {{question}}, {{goal}}, custom vars */
  promptTemplate: string;
  model: string; // key into models config
  variables?: Record<string, string>;
  /** Override the model's default temperature for this arm */
  temperature?: number;
  /** Temperature sweep: run this arm at each of these temperatures and compare scores.
   *  When set, `temperature` is ignored and the arm is fanned out into multiple sub-arms.
   *  Example: [0, 0.3, 0.7, 1.0] */
  temperatureSweep?: number[];
}

export interface ExperimentResult {
  armId: string;
  /** The model config key used for this arm (e.g. "balanced", "fast", "reasoning") */
  model: string;
  output: string;
  score: number | null;
  /** If scoring/parsing failed, this is the error message */
  scoreError?: string | null;
  costUsd: number;
  tokensUsed: { input: number; output: number };
  durationMs: number;
  /** Time-to-first-token in ms — 0 for non-streaming calls */
  latencyMs: number;
  timestamp: string;
  iteration: number;
  /** Whether this result came from cache */
  cached?: boolean;
  /** Run ID — always set when stored in memory */
  runId: string;
  /** Goal ID — always set when stored in memory */
  goalId: string;
}

export interface RunLog {
  goalId: string;
  runId: string;
  status: 'running' | 'completed' | 'quality_reached' | 'budget_exceeded' | 'failed';
  startedAt: string;
  completedAt: string;
  totalCostUsd: number;
  bestResult: ExperimentResult | undefined;
  allResults: ExperimentResult[];
  /** Hash of the question — used for cache lookup */
  questionHash?: string;
}

// ── Memory Types ─────────────────────────────────────────────────────────────

export interface PersistedResult extends ExperimentResult {
  runId: string;
  goalId: string;
}

// ── Export Types ─────────────────────────────────────────────────────────────

export type ExportFormat = 'json' | 'md' | 'html';

export interface ExportOptions {
  format: ExportFormat;
  includeScores?: boolean;
  includeCost?: boolean;
  includeMetadata?: boolean;
  theme?: 'light' | 'dark';
}

// ── Prompt Template Types ────────────────────────────────────────────────────

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  promptTemplate: string;
  recommendedModels?: string[];
  tags?: string[];
}
