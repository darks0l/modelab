import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EmbeddingStore } from '../src/embedding_store.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('EmbeddingStore', () => {
  let db: Database.Database;
  let store: EmbeddingStore;
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = path.join(__dirname, `test_embeddings_${Date.now()}.db`);
    db = new Database(tempDbPath);
    db.pragma('journal_mode = WAL');
    store = new EmbeddingStore(db);
  });

  afterEach(async () => {
    await store.flush();
    store.close();
    try { db.close(); } catch { /* ignore */ }
    try {
      const fs = require('fs') as typeof import('fs');
      fs.unlinkSync(tempDbPath);
      fs.unlinkSync(`${tempDbPath}-wal`);
      fs.unlinkSync(`${tempDbPath}-shm`);
    } catch { /* ignore */ }
  });

  // ── Basic operation ───────────────────────────────────────────────────────

  it('stores and retrieves a run embedding', async () => {
    store.storeRunEmbeddingSync('run-abc', 'What causes migraines?', 'Claude-sonnet outperformed GPT-4 by 2 points');

    const rows = db.prepare('SELECT * FROM run_embeddings WHERE run_id = ?').get('run-abc') as Record<string, unknown> | undefined;
    expect(rows).toBeDefined();
    expect(rows!.goal_text).toBe('What causes migraines?');
    expect(rows!.summary_text).toBe('Claude-sonnet outperformed GPT-4 by 2 points');
    expect(rows!.vector_type).toBe('tfidf');
  });

  it('stores and retrieves a lesson embedding', async () => {
    const id = store.storeLessonEmbeddingSync('Temperature 0.7 works best for creative tasks');

    const rows = db.prepare('SELECT * FROM lesson_embeddings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    expect(rows).toBeDefined();
    expect(rows!.lesson_text).toBe('Temperature 0.7 works best for creative tasks');
    expect(rows!.vector_type).toBe('tfidf');
  });

  // ── Semantic search ───────────────────────────────────────────────────────

  it('finds semantically similar runs', async () => {
    store.storeRunEmbeddingSync('run-1', 'How do neural networks learn?', 'Gradient descent explanation worked well');
    store.storeRunEmbeddingSync('run-2', 'What causes migraines?', 'Triptans are effective treatment');
    store.storeRunEmbeddingSync('run-3', 'Explain backpropagation in neural nets', 'Visual diagrams helped understanding');

    const results = await store.search('how do neural networks learn', 5);

    // run-1 (same topic) and run-3 (similar topic) should both be returned
    const runIds = results.filter(r => r.source === 'run').map(r => r.runId);
    expect(runIds).toContain('run-1');
    expect(runIds).toContain('run-3');
    expect(runIds).not.toContain('run-2');
  });

  it('returns results sorted by similarity score', async () => {
    store.storeRunEmbeddingSync('run-exact', 'What is machine learning?', 'Supervised learning overview provided');
    store.storeRunEmbeddingSync('run-similar', 'Explain AI and ML concepts', 'ML basics covered');
    store.storeRunEmbeddingSync('run-unrelated', 'What causes migraines?', 'Triptans discussion');

    const results = await store.search('what is machine learning', 10);
    const runResults = results.filter(r => r.source === 'run');

    // Results must be sorted by descending score
    for (let i = 1; i < runResults.length; i++) {
      expect(runResults[i - 1].score).toBeGreaterThanOrEqual(runResults[i].score);
    }

    // Exact match should be present (best match for exact query terms)
    const exactIdx = runResults.findIndex(r => r.runId === 'run-exact');
    expect(exactIdx).toBeGreaterThanOrEqual(0);

    // Unrelated should not appear before the exact match (if it appears at all)
    const unrelatedIdx = runResults.findIndex(r => r.runId === 'run-unrelated');
    if (unrelatedIdx >= 0) {
      expect(exactIdx).toBeLessThan(unrelatedIdx);
    }
  });

  it('returns lesson results alongside run results', async () => {
    store.storeRunEmbeddingSync('run-1', 'Neural network optimization', 'Adam optimizer worked best');
    const lessonId = store.storeLessonEmbeddingSync('Adam optimizer outperforms SGD for deep networks');

    const results = await store.search('which optimizer for deep learning', 10);

    const runResults = results.filter(r => r.source === 'run');
    const lessonResults = results.filter(r => r.source === 'lesson');

    expect(runResults.length).toBeGreaterThan(0);
    expect(lessonResults.length).toBeGreaterThan(0);
    expect(lessonResults[0].lessonText).toContain('Adam optimizer');
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      store.storeRunEmbeddingSync(`run-${i}`, `Topic ${i}`, `Summary ${i}`);
    }

    const results = await store.search('topic', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  // ── TF-IDF vector ─────────────────────────────────────────────────────────

  it('uses tfidf vector type when ollama unavailable', async () => {
    store.storeRunEmbeddingSync('run-tfidf', 'Test goal', 'Test summary');

    const rows = db.prepare('SELECT vector_type FROM run_embeddings WHERE run_id = ?').get('run-tfidf') as { vector_type: string } | undefined;
    expect(rows).toBeDefined();
    expect(rows!.vector_type).toBe('tfidf');
  });

  it('handles empty and short texts gracefully', async () => {
    store.storeRunEmbeddingSync('run-empty', '', '');
    store.storeRunEmbeddingSync('run-short', 'Hi', 'Ab');

    const results = await store.search('test query', 5);
    // Should not throw — just return whatever matches or empty
    expect(Array.isArray(results)).toBe(true);
  });

  // ── Schema ────────────────────────────────────────────────────────────────

  it('creates required tables on init', () => {
    const runTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_embeddings'").get();
    const lessonTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lesson_embeddings'").get();

    expect(runTable).toBeDefined();
    expect(lessonTable).toBeDefined();
  });

  it('allows multiple runs to be stored', async () => {
    store.storeRunEmbeddingSync('run-a', 'Topic A', 'Summary A');
    store.storeRunEmbeddingSync('run-b', 'Topic B', 'Summary B');
    store.storeRunEmbeddingSync('run-c', 'Topic C', 'Summary C');

    const rows = db.prepare('SELECT COUNT(*) as cnt FROM run_embeddings').get() as { cnt: number };
    expect(rows.cnt).toBe(3);
  });

  it('idempotent: replacing a run embedding updates it', async () => {
    store.storeRunEmbeddingSync('run-dup', 'Original question', 'Original summary');
    store.storeRunEmbeddingSync('run-dup', 'Updated question', 'Updated summary');

    const rows = db.prepare('SELECT * FROM run_embeddings WHERE run_id = ?').get('run-dup') as Record<string, unknown>;
    expect(rows.summary_text).toBe('Updated summary');
    expect(rows.goal_text).toBe('Updated question');

    const count = db.prepare('SELECT COUNT(*) as cnt FROM run_embeddings WHERE run_id = ?').get('run-dup') as { cnt: number };
    expect(count.cnt).toBe(1); // exactly 1, not 2
  });
});
