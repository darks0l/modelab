import type { ExperimentResult } from './types.js';
export interface CacheEntry {
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
    model: string;
    armId: string;
    durationMs: number;
}
export declare class Cache {
    private readonly path;
    private readonly ttlMs;
    private entries;
    constructor(ttlMs?: number);
    static hash(question: string, model: string, armId: string): string;
    get(key: string): CacheEntry | null;
    /** Store an experiment result in cache */
    set(key: string, result: ExperimentResult, question: string): void;
    lookup(question: string, model: string, armId: string): CacheEntry | null;
    private load;
    private persist;
    clear(): void;
    size(): number;
}
//# sourceMappingURL=cache.d.ts.map