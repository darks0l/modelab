import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
export class Cache {
    path;
    ttlMs;
    entries = new Map();
    loadError = null;
    constructor(ttlMs = 7 * 24 * 60 * 60 * 1000) {
        this.ttlMs = ttlMs;
        this.path = join(homedir(), '.modelab', 'cache.json');
        this.load();
    }
    /** Full SHA-256 hash — no truncation */
    static hash(question, modelKey, armId) {
        return createHash('sha256')
            .update(`${question}:${modelKey}:${armId}`)
            .digest('hex');
    }
    get(key) {
        const entry = this.entries.get(key);
        if (!entry)
            return null;
        const age = Date.now() - new Date(entry.timestamp).getTime();
        if (age > this.ttlMs) {
            this.entries.delete(key);
            this.persist();
            return null;
        }
        return entry;
    }
    /**
     * Store an experiment result in cache.
     * @param modelKey - the model config key, e.g. "fast", "balanced"
     */
    set(key, result, question, modelKey) {
        const entry = {
            hash: key,
            output: result.output,
            score: result.score,
            costUsd: result.costUsd,
            tokensUsed: result.tokensUsed,
            timestamp: result.timestamp,
            question,
            modelKey,
            armId: result.armId,
            durationMs: result.durationMs,
            latencyMs: result.latencyMs ?? 0,
        };
        this.entries.set(key, entry);
        this.persist();
    }
    lookup(question, modelKey, armId) {
        const key = Cache.hash(question, modelKey, armId);
        return this.get(key);
    }
    /** Returns the cache load error if any (e.g. corrupted file) */
    getLoadError() {
        return this.loadError;
    }
    load() {
        try {
            if (existsSync(this.path)) {
                const raw = readFileSync(this.path, 'utf8');
                const data = JSON.parse(raw);
                for (const entry of data) {
                    if (entry.hash && entry.output !== undefined) {
                        this.entries.set(entry.hash, entry);
                    }
                }
            }
        }
        catch (err) {
            this.loadError = err instanceof Error ? err : new Error(String(err));
            console.warn(`[modelab:cache] Failed to load cache (${this.path}): ${this.loadError.message}. Starting fresh.`);
        }
    }
    persist() {
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            writeFileSync(this.path, JSON.stringify([...this.entries.values()], null, 2));
        }
        catch (err) {
            console.error(`[modelab:cache] Failed to persist cache: ${err instanceof Error ? err.message : err}`);
        }
    }
    clear() {
        this.entries.clear();
        this.persist();
    }
    size() {
        return this.entries.size;
    }
}
//# sourceMappingURL=cache.js.map