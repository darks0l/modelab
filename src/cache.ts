import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

import type { ExperimentResult } from './types.js';

export interface CacheEntry {
  /** Full SHA-256 hash of question:model:armId */
  hash: string;
  output: string;
  /** First 200 chars of output — for quick preview in tables/history */
  outputPreview: string;
  /** True if output was truncated (>200 chars stored) */
  outputTruncated: boolean;
  score: number | null;
  costUsd: number;
  tokensUsed: { input: number; output: number };
  timestamp: string;
  question: string;
  /** Model config key, e.g. "fast", "balanced" */
  modelKey: string;
  armId: string;
  durationMs: number;
  latencyMs: number;
}

export class Cache {
  private readonly path: string;
  private readonly ttlMs: number;
  private entries: Map<string, CacheEntry> = new Map();
  private loadError: Error | null = null;

  constructor(ttlMs = 7 * 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.path = join(homedir(), '.modelab', 'cache.json');
    this.load();
  }

  /** Full SHA-256 hash — no truncation */
  static hash(question: string, modelKey: string, armId: string): string {
    return createHash('sha256')
      .update(`${question}:${modelKey}:${armId}`)
      .digest('hex');
  }

  get(key: string): CacheEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
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
  set(key: string, result: ExperimentResult, question: string, modelKey: string): void {
    const outputPreview = result.output.slice(0, 200);
    const entry: CacheEntry = {
      hash: key,
      output: result.output,
      outputPreview,
      outputTruncated: result.output.length > 200,
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

  lookup(question: string, modelKey: string, armId: string): CacheEntry | null {
    const key = Cache.hash(question, modelKey, armId);
    return this.get(key);
  }

  /** Returns the cache load error if any (e.g. corrupted file) */
  getLoadError(): Error | null {
    return this.loadError;
  }

  private load(): void {
    try {
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path, 'utf8');
        const data = JSON.parse(raw) as CacheEntry[];
        for (const entry of data) {
          if (entry.hash && entry.output !== undefined) {
            this.entries.set(entry.hash, entry);
          }
        }
      }
    } catch (err) {
      this.loadError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[modelab:cache] Failed to load cache (${this.path}): ${this.loadError.message}. Starting fresh.`);
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify([...this.entries.values()], null, 2));
    } catch (err) {
      console.error(`[modelab:cache] Failed to persist cache: ${err instanceof Error ? err.message : err}`);
    }
  }

  clear(): void {
    this.entries.clear();
    this.persist();
  }

  size(): number {
    return this.entries.size;
  }
}
