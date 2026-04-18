import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

import type { ExperimentResult } from './types.js';

export interface CacheEntry {
  hash: string;
  output: string;
  score: number | null;
  costUsd: number;
  tokensUsed: { input: number; output: number };
  timestamp: string;
  question: string;
  model: string;
  armId: string;
  durationMs: number;
}

export class Cache {
  private readonly path: string;
  private readonly ttlMs: number;
  private entries: Map<string, CacheEntry> = new Map();

  constructor(ttlMs = 7 * 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.path = join(homedir(), '.modelab', 'cache.json');
    this.load();
  }

  static hash(question: string, model: string, armId: string): string {
    return createHash('sha256')
      .update(`${question}:${model}:${armId}`)
      .digest('hex')
      .slice(0, 16);
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

  /** Store an experiment result in cache */
  set(key: string, result: ExperimentResult, question: string): void {
    const entry: CacheEntry = {
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

  lookup(question: string, model: string, armId: string): CacheEntry | null {
    const key = Cache.hash(question, model, armId);
    return this.get(key);
  }

  private load(): void {
    try {
      if (existsSync(this.path)) {
        const data = JSON.parse(readFileSync(this.path, 'utf8')) as CacheEntry[];
        for (const entry of data) {
          this.entries.set(entry.hash, entry);
        }
      }
    } catch { /* ignore */ }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify([...this.entries.values()], null, 2));
    } catch { /* ignore */ }
  }

  clear(): void {
    this.entries.clear();
    this.persist();
  }

  size(): number {
    return this.entries.size;
  }
}
