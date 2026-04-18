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
/**
 * Proactive rate limit tracker — prevents wasted requests by waiting before
 * sending when a provider has recently rate-limited us.
 *
 * Tracks per-(provider, model) last-429 timestamp and applies exponential
 * backoff before the next request. Also parses standard rate-limit headers
 * (X-RateLimit-*, Retry-After) when available.
 */
export declare class RateLimitTracker {
    private last429;
    private lastRetryAfter;
    private readonly defaultBackoffMs;
    private readonly maxBackoffMs;
    constructor(defaultBackoffMs?: number, maxBackoffMs?: number);
    /** key = "provider/model" */
    private key;
    /**
     * Called before a request. Returns true if we should wait first (rate limited recently).
     * Use the returned `waitMs` as the delay before sending.
     */
    shouldWait(provider: string, model: string): {
        wait: boolean;
        waitMs: number;
    };
    /**
     * Call after receiving a 429 response. Updates backoff state.
     * @param retryAfterMs - parsed Retry-After header if present, otherwise 0
     */
    record429(provider: string, model: string, retryAfterMs?: number): void;
    /**
     * Call after a successful request to a provider — clears the 429 penalty.
     */
    recordSuccess(provider: string, model: string): void;
    /**
     * Parse rate-limit headers from a successful response and update backoff state.
     * Supports: Retry-After, X-RateLimit-Reset, X-RateLimit-Remaining, RateLimit-Limit
     */
    parseRateLimitHeaders(provider: string, model: string, headers: Headers): void;
    /** Count 429s in the last 5 minutes for a given provider */
    private getRecent429Count;
    /** Clear all tracking state */
    reset(): void;
}
/** Singleton shared across all evaluator calls — import and reuse */
export declare const rateLimitTracker: RateLimitTracker;
//# sourceMappingURL=evaluator.d.ts.map