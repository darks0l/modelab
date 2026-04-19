/**
 * Complexity estimation based on keyword heuristics.
 * Extracted from router.ts to avoid circular imports with routing_v2.ts.
 */
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
//# sourceMappingURL=complexity.js.map