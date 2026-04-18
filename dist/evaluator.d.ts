import type { ModelConfig } from './types.js';
export declare function estimateTokens(text: string): number;
export interface CallResult {
    output: string;
    inputTokens: number;
    outputTokens: number;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
export declare function callModel(config: ModelConfig, prompt: string): Promise<string>;
export declare function callModelFull(config: ModelConfig, prompt: string, apiKey?: string): Promise<CallResult>;
//# sourceMappingURL=evaluator.d.ts.map