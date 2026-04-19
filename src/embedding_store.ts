/**
 * Embedding store — semantic memory for modelab.
 *
 * Provides vector/semantic search over past runs and lessons so modelab can
 * answer queries like "what did we learn about coding tasks?" without needing
 * exact-match structured queries.
 *
 * Architecture:
 * - Primary: Ollama at 192.168.68.73:11434 (nomic-embed-text or similar)
 * - Fallback: TF-IDF hash vectors (no external dependencies)
 * - Storage: SQLite rows in memory.db (run_embeddings, lesson_embeddings tables)
 * - Embedding generation is async — never blocks the main experiment loop
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EmbeddingVector {
  /** Raw float32 array as base64 — stored in SQLite BLOB */
  toBlob(): Buffer;
  /** Cosine similarity with another vector */
  cosineSimilarity(other: EmbeddingVector): number;
  readonly dimension: number;
}

export interface RunEmbedding {
  runId: string;
  goalText: string;
  summaryText: string;
  embedding: EmbeddingVector;
  createdAt: string;
}

export interface LessonEmbedding {
  id: number;
  lessonText: string;
  embedding: EmbeddingVector;
  createdAt: string;
}

export interface SemanticSearchResult {
  runId?: string;
  goalText?: string;
  summaryText?: string;
  lessonText?: string;
  score: number;
  /** Which table this came from */
  source: 'run' | 'lesson';
}

// ── Ollama Embedding ─────────────────────────────────────────────────────────

const OLLAMA_HOST = 'http://192.168.68.73:11434';
const EMBEDDING_MODEL = 'nomic-embed-text';

interface OllamaEmbeddingResponse {
  embeddings: number[][];
}

/**
 * Get real embeddings from Ollama. Returns null if Ollama is unavailable.
 */
async function getOllamaEmbedding(texts: string[]): Promise<number[][] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000); // 10s timeout

    const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: texts.join('\n') }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[embedding_store] Ollama returned ${res.status} — falling back to TF-IDF`);
      return null;
    }

    const json = await res.json() as OllamaEmbeddingResponse;
    return json.embeddings ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[embedding_store] Ollama unavailable (${msg}) — using TF-IDF fallback`);
    return null;
  }
}

// ── TF-IDF Fallback ──────────────────────────────────────────────────────────

/**
 * Simple TF-IDF-like hash vector for semantic similarity.
 * Converts text into a sparse word-frequency vector and normalizes it.
 * Good enough for a CLI tool without external dependencies.
 */
class TfIdfVector implements EmbeddingVector {
  private readonly vector: Map<number, number>;
  readonly dimension = 2048; // fixed hash-space dimension

  constructor(text: string) {
    this.vector = TfIdfVector.build(text);
  }

  static build(text: string): Map<number, number> {
    // Tokenize: split on non-alphanumeric, lowercase
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);

    // Document frequency across tokens in this single document (approximation)
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

    // Map to hash-space using multiple hash functions (SimHash-like)
    const vector = new Map<number, number>();
    for (const [token, count] of freq) {
      // Hash the token to a bucket in [0, DIMENSION)
      const h1 = hashWord(token, 0);
      const h2 = hashWord(token, 1);
      const h3 = hashWord(token, 2);
      const h4 = hashWord(token, 3);

      // Accumulate into 4 buckets with weighted contribution
      const idf = 1 + Math.log(1 + 1 / (0.01 + count));
      const weight = (count / tokens.length) * idf;

      vector.set(h1, (vector.get(h1) ?? 0) + weight);
      vector.set(h2, (vector.get(h2) ?? 0) - weight * 0.5);
      vector.set(h3, (vector.get(h3) ?? 0) + weight * 0.25);
      vector.set(h4, (vector.get(h4) ?? 0) - weight * 0.125);
    }

    // Normalize
    let norm = 0;
    for (const v of vector.values()) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (const k of vector.keys()) {
        vector.set(k, vector.get(k)! / norm);
      }
    }

    return vector;
  }

  toBlob(): Buffer {
    // Serialize as JSON string → buffer
    const obj: Record<string, number> = {};
    for (const [k, v] of this.vector) obj[k] = v;
    return Buffer.from(JSON.stringify(obj), 'utf8');
  }

  /** Reconstruct a TfIdfVector from a stored blob (after JSON parse). */
  static fromBlob(obj: Record<string, number>): TfIdfVector {
    const vec = new Map<number, number>();
    for (const [k, v] of Object.entries(obj)) vec.set(parseInt(k), v);
    return Object.setPrototypeOf({ vector: vec, dimension: 2048 }, TfIdfVector.prototype) as TfIdfVector;
  }

  cosineSimilarity(other: EmbeddingVector): number {
    if (!(other instanceof TfIdfVector)) return 0;
    let dot = 0;
    for (const [k, v] of this.vector) {
      dot += v * (other.vector.get(k) ?? 0);
    }
    return dot; // already normalized
  }
}

function hashWord(word: string, seed: number): number {
  const input = `${word}\x00${seed}`;
  const h = createHash('sha256').update(input).digest();
  // Use first 4 bytes as uint32, mod dimension
  const val = h.readUInt32BE(0);
  return val % 2048;
}

// ── OllamaVector ──────────────────────────────────────────────────────────────

class OllamaVector implements EmbeddingVector {
  readonly dimension: number;
  private readonly data: Float32Array;

  constructor(floatArray: number[]) {
    this.data = new Float32Array(floatArray);
    this.dimension = floatArray.length;
  }

  toBlob(): Buffer {
    return Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  }

  cosineSimilarity(other: EmbeddingVector): number {
    if (!(other instanceof OllamaVector)) return 0;
    let dot = 0;
    const minLen = Math.min(this.data.length, other.data.length);
    for (let i = 0; i < minLen; i++) {
      dot += this.data[i] * other.data[i];
    }
    return dot;
  }
}

// ── EmbeddingStore ───────────────────────────────────────────────────────────

export class EmbeddingStore {
  private db: Database.Database;
  private ollamaAvailable: boolean | null = null;
  private pendingJobs: Map<string, Promise<void>> = new Map();

  constructor(db?: Database.Database) {
    this.db = db ?? this.openDb();
    this.initSchema();
  }

  private openDb(): Database.Database {
    // Lazy import to avoid circular deps — only import here
    // We'll open the same DB as memory.ts (~/.modelab/memory.db)
    // but we don't import ExperimentMemory to avoid circular dependency.
    // Instead we open the DB directly at the well-known path.
    const { homedir } = require('os') as { homedir: () => string };
    const { join } = require('path') as { join: (...args: string[]) => string };
    const { mkdirSync, existsSync } = require('fs') as { mkdirSync: (p: string, o?: object) => void; existsSync: (p: string) => boolean };
    const dataDir = join(homedir(), '.modelab');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, 'memory.db');
    const db = new (require('better-sqlite3') as typeof Database)(dbPath);
    db.pragma('journal_mode = WAL');
    return db;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_embeddings (
        run_id      TEXT PRIMARY KEY,
        embedding   BLOB,
        summary_text TEXT NOT NULL DEFAULT '',
        goal_text   TEXT NOT NULL DEFAULT '',
        vector_type TEXT NOT NULL DEFAULT 'tfidf',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS lesson_embeddings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        embedding   BLOB,
        lesson_text TEXT NOT NULL DEFAULT '',
        vector_type TEXT NOT NULL DEFAULT 'tfidf',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_run_created ON run_embeddings(created_at);
      CREATE INDEX IF NOT EXISTS idx_lesson_created ON lesson_embeddings(created_at);
    `);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Synchronous version of storeRunEmbedding for testing.
   * Computes TF-IDF embedding and inserts immediately.
   */
  storeRunEmbeddingSync(runId: string, goalText: string, summaryText: string): void {
    const text = `${goalText}\n${summaryText}`.trim();
    const embedding = new TfIdfVector(text); // always sync TF-IDF for testing
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO run_embeddings (run_id, embedding, summary_text, goal_text, vector_type, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(runId, embedding.toBlob(), summaryText, goalText, 'tfidf');
  }

  /**
   * Store an embedding for a run. Non-blocking — kicks off async job.
   * Call storeRunEmbedding() and forget about it.
   */
  storeRunEmbedding(runId: string, goalText: string, summaryText: string): void {
    // Fire and forget — don't await
    this.scheduleStore(`run:${runId}`, async () => {
      const text = `${goalText}\n${summaryText}`.trim();
      const embedding = await this.computeEmbedding(text);
      if (!embedding) return;

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO run_embeddings (run_id, embedding, summary_text, goal_text, vector_type, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `);
      stmt.run(runId, embedding.toBlob(), summaryText, goalText, embedding instanceof OllamaVector ? 'ollama' : 'tfidf');
    });
  }

  /**
   * Synchronous version of storeLessonEmbedding for testing.
   */
  storeLessonEmbeddingSync(lessonText: string): number {
    const embedding = new TfIdfVector(lessonText);
    const stmt = this.db.prepare(`
      INSERT INTO lesson_embeddings (embedding, lesson_text, vector_type, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `);
    const info = stmt.run(embedding.toBlob(), lessonText, 'tfidf');
    return info.lastInsertRowid as number;
  }

  /**
   * Store an embedding for a lesson. Non-blocking.
   */
  storeLessonEmbedding(lessonText: string): number {
    const id = Date.now(); // approximate ID
    this.scheduleStore(`lesson:${id}`, async () => {
      const embedding = await this.computeEmbedding(lessonText);
      if (!embedding) return;

      // Get the actual auto-increment id
      const realId = this.db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };

      const stmt = this.db.prepare(`
        INSERT INTO lesson_embeddings (embedding, lesson_text, vector_type, created_at)
        VALUES (?, ?, ?, datetime('now'))
      `);
      stmt.run(embedding.toBlob(), lessonText, embedding instanceof OllamaVector ? 'ollama' : 'tfidf');
    });
    return id;
  }

  /**
   * Semantic search over past runs and lessons.
   * Returns results sorted by cosine similarity descending.
   */
  async search(query: string, limit = 10): Promise<SemanticSearchResult[]> {
    const queryEmbedding = await this.computeEmbedding(query);
    if (!queryEmbedding) return [];

    const results: SemanticSearchResult[] = [];

    // Search runs
    const runRows = this.db.prepare(
      'SELECT run_id, goal_text, summary_text, embedding, vector_type FROM run_embeddings'
    ).all() as Array<{
      run_id: string; goal_text: string; summary_text: string; embedding: Buffer; vector_type: string;
    }>;

    for (const row of runRows) {
      const vec = this.blobToVector(row.embedding, row.vector_type);
      if (!vec) continue;
      const score = queryEmbedding.cosineSimilarity(vec);
      if (score > 0.1) { // threshold: only return meaningful matches
        results.push({ runId: row.run_id, goalText: row.goal_text, summaryText: row.summary_text, score, source: 'run' });
      }
    }

    // Search lessons
    const lessonRows = this.db.prepare(
      'SELECT id, lesson_text, embedding, vector_type FROM lesson_embeddings'
    ).all() as Array<{
      id: number; lesson_text: string; embedding: Buffer; vector_type: string;
    }>;

    for (const row of lessonRows) {
      const vec = this.blobToVector(row.embedding, row.vector_type);
      if (!vec) continue;
      const score = queryEmbedding.cosineSimilarity(vec);
      if (score > 0.1) {
        results.push({ lessonText: row.lesson_text, score, source: 'lesson' });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Find runs similar to a given run's goal text.
   */
  async findSimilarRuns(goalText: string, limit = 5): Promise<SemanticSearchResult[]> {
    return this.search(goalText, limit);
  }

  /**
   * Check for conflicting or reinforcing lessons before applying a new lesson.
   * Returns lessons with similarity > threshold.
   */
  async checkLessonConflicts(newLesson: string, threshold = 0.7): Promise<LessonEmbedding[]> {
    const queryEmbedding = await this.computeEmbedding(newLesson);
    if (!queryEmbedding) return [];

    const rows = this.db.prepare(
      'SELECT id, lesson_text, embedding, vector_type, created_at FROM lesson_embeddings'
    ).all() as Array<{
      id: number; lesson_text: string; embedding: Buffer; vector_type: string; created_at: string;
    }>;

    const conflicts: LessonEmbedding[] = [];
    for (const row of rows) {
      const vec = this.blobToVector(row.embedding, row.vector_type);
      if (!vec) continue;
      const score = queryEmbedding.cosineSimilarity(vec);
      if (score >= threshold) {
        conflicts.push({ id: row.id, lessonText: row.lesson_text, embedding: vec, createdAt: row.created_at });
      }
    }
    return conflicts;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async computeEmbedding(text: string): Promise<EmbeddingVector | null> {
    // Try Ollama first (only once per session)
    if (this.ollamaAvailable === null) {
      this.ollamaAvailable = await this.checkOllama();
    }

    if (this.ollamaAvailable) {
      const embeddings = await getOllamaEmbedding([text]);
      if (embeddings && embeddings.length > 0) {
        return new OllamaVector(embeddings[0]);
      }
      // Ollama stopped working — mark unavailable and fall through
      this.ollamaAvailable = false;
    }

    // Fallback: TF-IDF
    return new TfIdfVector(text);
  }

  private async checkOllama(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  private blobToVector(blob: Buffer, vectorType: string): EmbeddingVector | null {
    try {
      if (vectorType === 'ollama') {
        const arr = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
        return new OllamaVector(Array.from(arr));
      } else {
        const obj = JSON.parse(blob.toString('utf8')) as Record<string, number>;
        return TfIdfVector.fromBlob(obj);
      }
    } catch {
      return null;
    }
  }

  private scheduleStore(key: string, job: () => Promise<void>): void {
    // If there's already a pending job for this key, don't queue a duplicate
    if (this.pendingJobs.has(key)) return;
    const promise = job().catch(err => {
      console.warn(`[embedding_store] Background job failed (${key}): ${err instanceof Error ? err.message : err}`);
    }).finally(() => {
      this.pendingJobs.delete(key);
    });
    this.pendingJobs.set(key, promise);
  }

  /**
   * Wait for all pending background jobs to complete.
   * Call this in tests before closing the DB connection.
   */
  async flush(): Promise<void> {
    const jobs = [...this.pendingJobs.values()];
    await Promise.all(jobs);
  }

  close(): void {
    this.db.close();
  }
}

// Singleton instance — initialized lazily
let _instance: EmbeddingStore | null = null;

export function getEmbeddingStore(): EmbeddingStore {
  if (!_instance) _instance = new EmbeddingStore();
  return _instance;
}
