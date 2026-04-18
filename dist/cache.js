import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
export class Cache {
    path;
    ttlMs;
    entries = new Map();
    constructor(ttlMs = 7 * 24 * 60 * 60 * 1000) {
        this.ttlMs = ttlMs;
        this.path = join(homedir(), '.modelab', 'cache.json');
        this.load();
    }
    static hash(question, model, armId) {
        return createHash('sha256')
            .update(`${question}:${model}:${armId}`)
            .digest('hex')
            .slice(0, 16);
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
    /** Store an experiment result in cache */
    set(key, result, question) {
        const entry = {
            hash: key,
            output: result.output,
            score: result.score,
            costUsd: result.costUsd,
            tokensUsed: result.tokensUsed,
            timestamp: result.timestamp,
            question,
            model: result.armId,
            armId: result.armId,
            durationMs: result.durationMs,
        };
        this.entries.set(key, entry);
        this.persist();
    }
    lookup(question, model, armId) {
        const key = Cache.hash(question, model, armId);
        return this.get(key);
    }
    load() {
        try {
            if (existsSync(this.path)) {
                const data = JSON.parse(readFileSync(this.path, 'utf8'));
                for (const entry of data) {
                    this.entries.set(entry.hash, entry);
                }
            }
        }
        catch { /* ignore */ }
    }
    persist() {
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            writeFileSync(this.path, JSON.stringify([...this.entries.values()], null, 2));
        }
        catch { /* ignore */ }
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