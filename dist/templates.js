export const BUILT_IN_TEMPLATES = [
    {
        id: 'research',
        name: 'Deep Research',
        description: 'Thorough multi-angle research on a complex question',
        tags: ['research', 'analysis'],
        recommendedModels: ['balanced', 'reasoning'],
        promptTemplate: `You are a senior research analyst. Conduct a thorough investigation of the following question.

Question: {{question}}
Goal: {{goal}}

Requirements:
- Cover multiple perspectives and angles
- Cite specific examples and evidence where possible
- Identify key tensions, trade-offs, or open questions
- Conclude with a nuanced summary and your strongest recommendation or conclusion

Provide a comprehensive, well-structured response.`,
    },
    {
        id: 'code-review',
        name: 'Code Review',
        description: 'Review code for bugs, performance issues, security concerns, and best practices',
        tags: ['coding', 'review', 'security'],
        recommendedModels: ['coding', 'balanced'],
        promptTemplate: `You are a senior software engineer conducting a thorough code review.

Code to review:
{{question}}

Review this code for:
- Critical bugs and logic errors
- Security vulnerabilities (injection, auth bypass, data leaks)
- Performance issues and scalability concerns
- API design and architecture quality
- Adherence to best practices for the language/framework
- Error handling and edge cases

Provide specific, actionable feedback with code examples where helpful. Rate severity (critical/high/medium/low) for each issue found.`,
    },
    {
        id: 'architecture',
        name: 'System Architecture',
        description: 'Design or critique software system architectures',
        tags: ['architecture', 'systems', 'design'],
        recommendedModels: ['reasoning', 'balanced'],
        promptTemplate: `You are a principal engineer specializing in distributed systems and software architecture.

Task: {{question}}
Goal: {{goal}}

Consider:
- Scalability requirements and bottlenecks
- Consistency vs availability trade-offs
- Failure modes and resilience patterns
- Data modeling and storage choices
- API design and service boundaries
- Deployment and operational complexity
- Cost implications at scale

Provide a detailed architecture recommendation with pros/cons, diagrams described in text, and specific technology choices where relevant.`,
    },
    {
        id: 'bug-hunt',
        name: 'Bug Hunter',
        description: 'Systematically find bugs, edge cases, and failure modes',
        tags: ['debugging', 'testing', 'coding'],
        recommendedModels: ['coding', 'reasoning'],
        promptTemplate: `You are a bug hunter and quality assurance engineer. Your mission is to find everything that could go wrong.

Subject: {{question}}

Your task:
- Enumerate every possible failure mode and edge case
- For each bug found, provide: description, root cause, severity (critical/high/medium/low), and a minimal reproduction case
- Consider: null/undefined handling, race conditions, overflow, concurrency issues, malformed input, security exploits, resource leaks
- Think adversarial: what would a malicious actor try to break?

Be thorough. It's better to flag something as a false positive than to miss a real bug.`,
    },
    {
        id: 'compare',
        name: 'Compare & Decide',
        description: 'Compare options and make a reasoned recommendation',
        tags: ['decision', 'comparison', 'research'],
        recommendedModels: ['balanced', 'reasoning'],
        promptTemplate: `You are a technology advisor helping make a strategic decision.

Decision to make: {{question}}
Success criteria: {{goal}}

For the options under consideration:
- List the key dimensions of comparison
- Score each option on each dimension (1-10)
- Identify trade-offs and win conditions for each
- Flag common pitfalls and misconceptions
- Provide a clear recommendation with confidence level and reasoning

Be direct. Tell me what to do and why, not just the facts.`,
    },
    {
        id: 'quick-answer',
        name: 'Quick Answer',
        description: 'Fast, concise answer to a simple question',
        tags: ['quick', 'summary'],
        recommendedModels: ['fast', 'balanced'],
        promptTemplate: `Answer the following question concisely and accurately.

Question: {{question}}

Provide a direct, well-organized answer. Be specific. Avoid unnecessary preamble. If you're uncertain, say so clearly.`,
    },
    {
        id: 'creative',
        name: 'Creative & Brainstorm',
        description: 'Generate creative ideas, names, or approaches',
        tags: ['creative', 'brainstorm'],
        recommendedModels: ['balanced', 'fast'],
        promptTemplate: `You are a creative consultant. Generate innovative, diverse ideas for the following challenge.

Challenge: {{question}}
Goal: {{goal}}

Generate as many distinct ideas as possible. Push boundaries. Include wildcards and unconventional approaches alongside practical ones. For each idea, briefly explain what makes it interesting.

Prioritize originality and impact over safety.`,
    },
];
export function getTemplate(id) {
    return BUILT_IN_TEMPLATES.find(t => t.id === id);
}
export function listTemplates() {
    return BUILT_IN_TEMPLATES;
}
//# sourceMappingURL=templates.js.map