import type { ModelConfig } from './types.js';
/** Sync-safe token estimate using BPE; falls back to length/4. */
export declare function estimateTokens(text: string): number;
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
interface RetryOptions {
    maxRetries: number;
    initialDelayMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
}
export declare class RateLimitTracker {
    private proactiveUntil;
    private reactiveCountdown;
    private readonly defaultBackoffMs;
    private readonly maxBackoffMs;
    constructor(defaultBackoffMs?: number, maxBackoffMs?: number);
    private key;
    /**
     * Should we wait before sending the next request?
     *
     * Two independent signals:
     * - Proactive (header-driven): server-sent Retry-After / X-RateLimit-Reset hints
     * - Reactive (locally-observed): exponential backoff after a 429 without headers
     *
     * The MAX is used so both signals can coexist without conflicting.
     * For explicit Retry-After headers, proactive dominates.
     * For 429s without headers, reactive kicks in.
     */
    shouldWait(provider: string, model: string): {
        wait: boolean;
        waitMs: number;
    };
    /**
     * Record a locally-observed 429. Increments the reactive countdown
     * (so the NEXT shouldWait call returns a penalty) and stores the explicit
     * retry-after if provided.
     */
    record429(provider: string, model: string, retryAfterMs?: number): void;
    recordSuccess(provider: string, model: string): void;
    /**
     * Parse server-sent rate-limit headers and update proactive backoff.
     */
    parseRateLimitHeaders(provider: string, model: string, headers: Headers): void;
    reset(): void;
}
export declare const rateLimitTracker: RateLimitTracker;
/** Reset the global rateLimitTracker singleton — used in tests to prevent cross-test pollution. */
export declare function resetRateLimitTracker(): void;
export declare function fetchWithRetry(url: string, options: RequestInit, opts?: Partial<RetryOptions> & {
    provider?: string;
    model?: string;
}): Promise<Response>;
export declare function callModel(config: ModelConfig, prompt: string): Promise<string>;
export declare function callModelFull(config: ModelConfig, prompt: string, apiKey?: string): Promise<CallResult>;
export {};
//# sourceMappingURL=evaluator.d.ts.map