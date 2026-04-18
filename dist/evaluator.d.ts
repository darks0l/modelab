import type { ModelConfig } from './types.js';
/** Synchronous token estimate — uses BPE when available, length/4 as fallback.
 * This is the primary export; it is sync-safe and fast (< 1ms per call once warm).
 */
export declare function estimateTokens(text: string): number;
/** Async token estimate — always returns an accurate BPE count.
 * Use this in async contexts where you want the best accuracy from the first call.
 */
export declare function estimateTokensAsync(text: string): Promise<number>;
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