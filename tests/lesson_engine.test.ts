import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLessonEngineForTest, resetLessonEngine } from '../src/lesson_engine.js';

describe('LessonEngine', () => {
  let engine: ReturnType<typeof getLessonEngineForTest>;

  beforeEach(() => {
    resetLessonEngine();
    engine = getLessonEngineForTest(':memory:');
  });

  afterEach(() => {
    engine.close();
  });

  describe('model_profiles', () => {
    it('creates a new profile for a model after a run', () => {
      engine.updateProfiles([
        { model: 'balanced', score: 8.5, costUsd: 0.001, latencyMs: 1200, armId: 'arm-1' },
      ], 'What is 2+2?');

      const profile = engine.getProfile('balanced');
      expect(profile).not.toBeNull();
      expect(profile!.avgScore).toBe(8.5);
      expect(profile!.runsCount).toBe(1);
      expect(profile!.avgLatencyMs).toBe(1200);
      expect(profile!.avgCostUsd).toBe(0.001);
    });

    it('updates an existing profile with a running average', () => {
      engine.updateProfiles([
        { model: 'balanced', score: 7.0, costUsd: 0.001, latencyMs: 1000, armId: 'arm-1' },
      ], 'What is 2+2?');
      engine.updateProfiles([
        { model: 'balanced', score: 9.0, costUsd: 0.002, latencyMs: 2000, armId: 'arm-2' },
      ], 'What is 2+2?');

      const profile = engine.getProfile('balanced');
      expect(profile!.avgScore).toBe(8.0); // (7+9)/2
      expect(profile!.runsCount).toBe(2);
    });

    it('infers task type and records strengths for high-scoring runs', () => {
      engine.updateProfiles([
        { model: 'claude-sonnet', score: 8.5, costUsd: 0.001, latencyMs: 1500, armId: 'arm-1' },
      ], 'Explain why the sky is blue using physics reasoning');

      const profile = engine.getProfile('claude-sonnet');
      expect(profile!.strengths).toContain('reasoning');
    });

    it('infers task type and records weaknesses for low-scoring runs', () => {
      engine.updateProfiles([
        { model: 'fast', score: 3.5, costUsd: 0.001, latencyMs: 500, armId: 'arm-1' },
      ], 'Debug this complex TypeScript code with generics');

      const profile = engine.getProfile('fast');
      expect(profile!.weaknesses).toContain('coding');
    });

    it('getAllProfiles returns profiles sorted by avg_score desc', () => {
      engine.updateProfiles([
        { model: 'slow', score: 6.0, costUsd: 0.001, latencyMs: 3000, armId: 'arm-1' },
        { model: 'fast', score: 9.0, costUsd: 0.001, latencyMs: 500, armId: 'arm-2' },
      ], 'Quick summary of the news');

      const profiles = engine.getAllProfiles();
      expect(profiles[0].modelKey).toBe('fast');
      expect(profiles[1].modelKey).toBe('slow');
    });
  });

  describe('router_adjustments', () => {
    it('writes and retrieves a score_delta adjustment', () => {
      engine.writeAdjustment('glm', 'score_delta', -1.5,
        'Lesson: GLM performs poorly on coding tasks', null);

      const adj = engine.getActiveAdjustments('glm');
      expect(adj).toHaveLength(1);
      expect(adj[0].adjustmentType).toBe('score_delta');
      expect(adj[0].delta).toBe(-1.5);
    });

    it('writes and retrieves a weight_boost adjustment', () => {
      engine.writeAdjustment('claude-sonnet', 'weight_boost', 0.5,
        'Lesson: Claude Sonnet outperforms others on reasoning', null);

      const adj = engine.getActiveAdjustments('claude-sonnet');
      expect(adj).toHaveLength(1);
      expect(adj[0].adjustmentType).toBe('weight_boost');
      expect(adj[0].delta).toBe(0.5);
    });

    it('writes and retrieves a temp_override adjustment', () => {
      engine.writeAdjustment('balanced', 'temp_override', 0.7,
        'Lesson: use temperature 0.7 for reasoning tasks', null);

      const adj = engine.getActiveAdjustments('balanced');
      expect(adj).toHaveLength(1);
      expect(adj[0].adjustmentType).toBe('temp_override');
      expect(adj[0].delta).toBe(0.7);
    });

    it('resolves adjustments — aggregates score_delta and weight_boost', () => {
      engine.writeAdjustment('balanced', 'score_delta', -0.5, 'First penalty', null);
      engine.writeAdjustment('balanced', 'score_delta', -0.5, 'Second penalty', null);
      engine.writeAdjustment('balanced', 'weight_boost', 0.3, 'Boost', null);

      const resolved = engine.resolveAdjustments('balanced');
      expect(resolved.effectiveScore).toBe(-1.0); // -0.5 + -0.5
      expect(resolved.delta).toBe(0.3); // weight boost sum
    });

    it('resolves temp_override — returns latest', () => {
      engine.writeAdjustment('balanced', 'temp_override', 0.5, 'Old temp', null);
      engine.writeAdjustment('balanced', 'temp_override', 0.7, 'New temp', null);

      const resolved = engine.resolveAdjustments('balanced');
      expect(resolved.temperatureOverride).toBe(0.7); // latest
    });
  });

  describe('processRunLesson', () => {
    it('applies auto-boost for excellent scores (>= 8)', () => {
      const applied = engine.processRunLesson(
        'arm-balanced scored 9/10.',
        { modelKey: 'balanced', score: 9, taskType: 'general' }
      );

      expect(applied.some(a => a.changeMade?.reason === 'auto-boost excellent score')).toBe(true);
      const adj = engine.getActiveAdjustments('balanced');
      expect(adj.some(a => a.adjustmentType === 'weight_boost' && a.delta === 0.3)).toBe(true);
    });

    it('applies auto-penalty for poor scores (< 4)', () => {
      const applied = engine.processRunLesson(
        'arm-glm scored 3/10.',
        { modelKey: 'glm', score: 3, taskType: 'coding' }
      );

      expect(applied.some(a => a.changeMade?.reason === 'auto-penalize poor score')).toBe(true);
      const adj = engine.getActiveAdjustments('glm');
      expect(adj.some(a => a.adjustmentType === 'score_delta' && a.delta === -1)).toBe(true);
    });

    it('parses "performs poorly on X tasks" lesson', () => {
      const result = engine.applyLesson(
        'GLM performs poorly on code tasks.',
        { modelKey: 'glm', score: 3 }
      );

      expect(result).not.toBeNull();
      const adj = engine.getActiveAdjustments('glm');
      expect(adj.some(a => a.adjustmentType === 'score_delta' && a.delta === -1.5)).toBe(true);
    });

    it('parses "outperforms on X tasks" lesson', () => {
      const result = engine.applyLesson(
        'Claude Sonnet outperforms GPT-4 on reasoning tasks.',
        { modelKey: 'claude-sonnet', score: 8 }
      );

      expect(result).not.toBeNull();
      const adj = engine.getActiveAdjustments('claude-sonnet');
      expect(adj.some(a => a.adjustmentType === 'weight_boost' && a.delta === 0.5)).toBe(true);
    });

    it('parses "use temperature X for Y tasks" lesson', () => {
      const result = engine.applyLesson(
        'Use temperature 0.7 for reasoning tasks.',
        { modelKey: 'reasoning', score: 7 }
      );

      expect(result).not.toBeNull();
      const adj = engine.getActiveAdjustments('reasoning');
      expect(adj.some(a => a.adjustmentType === 'temp_override' && a.delta === 0.7)).toBe(true);
    });

    it('records applied lessons in the applied_lessons table', () => {
      engine.processRunLesson('arm-balanced scored 9/10.', {
        modelKey: 'balanced', score: 9,
      });

      const lessons = engine.getAppliedLessons();
      expect(lessons.length).toBeGreaterThan(0);
    });
  });

  describe('applied_lessons', () => {
    it('sets and retrieves effectiveness scores', () => {
      engine.processRunLesson('arm-balanced scored 9/10.', {
        modelKey: 'balanced', score: 9,
      });

      const lessons = engine.getAppliedLessons();
      const lessonId = lessons[0].id!;

      // Simulate next run evaluating the lesson's effectiveness
      engine.setLessonEffectiveness(lessonId, 8.5);
      const updated = engine.getAppliedLessons();
      expect(updated[0].effectivenessScore).toBe(8.5);
    });
  });
});
