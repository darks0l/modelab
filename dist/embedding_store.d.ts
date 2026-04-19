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
export declare class EmbeddingStore {
    private db;
    private ollamaAvailable;
    private pendingJobs;
    constructor(db?: Database.Database);
    private openDb;
    private initSchema;
    /**
     * Synchronous version of storeRunEmbedding for testing.
     * Computes TF-IDF embedding and inserts immediately.
     */
    storeRunEmbeddingSync(runId: string, goalText: string, summaryText: string): void;
    /**
     * Store an embedding for a run. Non-blocking — kicks off async job.
     * Call storeRunEmbedding() and forget about it.
     */
    storeRunEmbedding(runId: string, goalText: string, summaryText: string): void;
    /**
     * Synchronous version of storeLessonEmbedding for testing.
     */
    storeLessonEmbeddingSync(lessonText: string): number;
    /**
     * Store an embedding for a lesson. Non-blocking.
     */
    storeLessonEmbedding(lessonText: string): number;
    /**
     * Semantic search over past runs and lessons.
     * Returns results sorted by cosine similarity descending.
     */
    search(query: string, limit?: number): Promise<SemanticSearchResult[]>;
    /**
     * Find runs similar to a given run's goal text.
     */
    findSimilarRuns(goalText: string, limit?: number): Promise<SemanticSearchResult[]>;
    /**
     * Check for conflicting or reinforcing lessons before applying a new lesson.
     * Returns lessons with similarity > threshold.
     */
    checkLessonConflicts(newLesson: string, threshold?: number): Promise<LessonEmbedding[]>;
    private computeEmbedding;
    private checkOllama;
    private blobToVector;
    private scheduleStore;
    /**
     * Wait for all pending background jobs to complete.
     * Call this in tests before closing the DB connection.
     */
    flush(): Promise<void>;
    close(): void;
}
export declare function getEmbeddingStore(): EmbeddingStore;
//# sourceMappingURL=embedding_store.d.ts.map