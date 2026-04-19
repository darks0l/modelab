const CODE_KEYWORDS = /\b(code|function|refactor|bug|fix|test|build|repo|pull.request|pr\b|typescript|javascript|python|rust|compile|lint|eslint|prettier|npm|yarn|cargo)\b/i;
const REASON_KEYWORDS = /\b(reason|proof|logic|analysis|analyze|theorem|prove|conjecture|derive|evaluate|compare|contrast|critique|synthesis|reasoning.step|step.by.step|glm-5|glm5|glm-4.7|glm4.7|glm-5.1|glm5.1|glm-5.0|glm5.0|glm4\b)\b/i;
const QUICK_KEYWORDS = /\b(quick|small|summary|brief|one.liner|quick.summary|what.is|define|lookup)\b/i;
export function estimateComplexity(task) {
    if (CODE_KEYWORDS.test(task))
        return 'coding';
    if (REASON_KEYWORDS.test(task))
        return 'reasoning';
    if (QUICK_KEYWORDS.test(task))
        return 'quick';
    return 'balanced';
}
/**
 * Route a task to the best-fit model from a configured model pool.
 *
 * Routing logic:
 * - coding task  → look for "coding" key, else "balanced"
 * - reasoning    → "reasoning" > "balanced"
 * - quick task  → "fast" > "balanced"
 * - default     → "balanced"
 *
 * If the preferred key is missing, falls back to "balanced".
 *
 * With mode='latency', routes to the model configured as 'fast' if available,
 * regardless of task complexity — useful for interactive/low-latency applications.
 * With mode='cost', prefers models with lower costPerMillionOutput.
 */
export function routeTask(task, modelConfigs, mode = 'quality') {
    if (mode === 'latency') {
        if (Object.keys(modelConfigs).includes('fast')) {
            const cfg = modelConfigs['fast'];
            return { model: cfg.model, provider: cfg.provider, reasoning: `latency mode → "fast" (${cfg.provider})` };
        }
        // Fall back to cheapest by output cost
        const cheapest = Object.entries(modelConfigs).sort(([, a], [, b]) => (a.costPerMillionOutput ?? 0) - (b.costPerMillionOutput ?? 0))[0];
        if (cheapest) {
            return { model: cheapest[1].model, provider: cheapest[1].provider, reasoning: `latency mode → cheapest by output cost (${cheapest[0]})` };
        }
    }
    if (mode === 'cost') {
        const sorted = Object.entries(modelConfigs).sort(([, a], [, b]) => (a.costPerMillionOutput ?? 0) - (b.costPerMillionOutput ?? 0));
        const key = sorted[0][0];
        const cfg = sorted[0][1];
        return { model: cfg.model, provider: cfg.provider, reasoning: `cost mode → "${key}" (${cfg.provider}) @ $${cfg.costPerMillionOutput}/1M out` };
    }
    const complexity = estimateComplexity(task);
    const keys = Object.keys(modelConfigs);
    const preferenceMap = {
        coding: ['coding', 'balanced', 'fast', 'reasoning', 'glm-reasoning'],
        reasoning: ['reasoning', 'glm-reasoning', 'glm5', 'glm51', 'glm', 'balanced', 'fast'],
        quick: ['fast', 'glm-fast', 'balanced'],
        balanced: ['balanced', 'glm', 'glm5', 'glm51', 'fast', 'reasoning', 'coding', 'glm-reasoning'],
    };
    const preferred = preferenceMap[complexity];
    for (const key of preferred) {
        if (keys.includes(key)) {
            return { model: modelConfigs[key].model, provider: modelConfigs[key].provider, reasoning: `${complexity} task → "${key}" (${modelConfigs[key].provider})` };
        }
    }
    const first = keys[0];
    return { model: modelConfigs[first].model, provider: modelConfigs[first].provider, reasoning: `fallback → "${first}"` };
}
/**
 * Calculate USD cost for a token usage report.
 */
export function calcCost(inputTokens, outputTokens, config) {
    const inputRate = config.costPerMillionInput ?? 0;
    const outputRate = config.costPerMillionOutput ?? 0;
    return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}
//# sourceMappingURL=router.js.map