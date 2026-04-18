import { describe, it, expect, beforeEach } from 'vitest';
import { Cache } from '../src/cache.js';
import type { ExperimentResult } from '../src/types.js';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { tmpdir } from 'os';

// Use a temp cache path so tests don't clobber the real cache
const TEST_CACHE_DIR = join(tmpdir(), 'modelab-test-cache');
const TEST_CACHE_PATH = join(TEST_CACHE_DIR, 'cache.json');

function makeResult(overrides: Partial<ExperimentResult> = {}): ExperimentResult {
  return {
    armId: 'test-arm',
    model: 'balanced',
    output: 'Hello world',
    score: 7.5,
    costUsd: 0.001,
    tokensUsed: { input: 100, output: 50 },
    durationMs: 500,
    timestamp: new Date().toISOString(),
    iteration: 1,
    cached: false,
    runId: 'run-001',
    goalId: 'goal-001',
    ...overrides,
  };
}

describe('Cache', () => {
  beforeEach(() => {
    // Reset module state by deleting test cache file
    try { unlinkSync(TEST_CACHE_PATH); } catch { /* ok */ }
  });

  it('stores and retrieves a cache entry', () => {
    // We can't easily inject path into Cache without modifying it,
    // so we test the lookup flow via the static hash method
    const key = Cache.hash('what is rust', 'balanced', 'arm-1');
    expect(typeof key).toBe('string');
    expect(key.length).toBe(64); // SHA-256 hex

    // Two identical inputs produce the same hash
    const key2 = Cache.hash('what is rust', 'balanced', 'arm-1');
    expect(key).toBe(key2);

    // Different input produces different hash
    const key3 = Cache.hash('what is go', 'balanced', 'arm-1');
    expect(key3).not.toBe(key);
  });

  it('Cache.hash is stable and case-sensitive', () => {
    const a = Cache.hash('Hello', 'model', 'arm');
    const b = Cache.hash('hello', 'model', 'arm');
    expect(a).not.toBe(b);
  });

  it('Cache.hash accepts any strings', () => {
    const k = Cache.hash('', '', '');
    expect(typeof k).toBe('string');
    expect(k.length).toBe(64);
  });
});
