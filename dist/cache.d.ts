import type { ExperimentResult } from './types.js';
export interface CacheEntry {
    /** Full SHA-256 hash of question:model:armId */
    hash: string;
    output: string;
    score: number | null;
    costUsd: number;
    tokensUsed: {
        input: number;
        output: number;
    };
    timestamp: string;
    question: string;
    /** Model config key, e.g. "fast", "balanced" */
    modelKey: string;
    armId: string;
    durationMs: number;
}
export declare class Cache {
    private readonly path;
    private readonly ttlMs;
    private entries;
    private loadError;
    constructor(ttlMs?: number);
    /** Full SHA-256 hash — no truncation */
    static hash(question: string, modelKey: string, armId: string): string;
    get(key: string): CacheEntry | null;
    /**
     * Store an experiment result in cache.
     * @param modelKey - the model config key, e.g. "fast", "balanced"
     */
    set(key: string, result: ExperimentResult, question: string, modelKey: string): void;
    lookup(question: string, modelKey: string, armId: string): CacheEntry | null;
    /** Returns the cache load error if any (e.g. corrupted file) */
    getLoadError(): Error | null;
    private load;
    private persist;
    clear(): void;
    size(): number;
}
//# sourceMappingURL=cache.d.ts.map