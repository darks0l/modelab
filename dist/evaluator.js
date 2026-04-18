/**
 * Simple LLM judge — sends output + question to a configured eval model
 * and parses a 0–10 score from the response.
 *
 * Prompt: structured rubric asking the model to score on
 *   clarity (0–3), correctness (0–4), completeness (0–3)
 */
export async function evaluate(output, question, evalModel) {
    const prompt = `You are an impartial evaluator. Score the following answer to the question.

Question: ${question}

Answer:
${output}

Respond ONLY with a JSON object: {"score": <0-10>, "reasoning": "<1-sentence>"}
Score rubric:
- 0-3: clarity — is the answer clear and readable?
- 0-4: correctness — is the answer factually/reasoningly sound?
- 0-3: completeness — does it fully address the question?

Return only the JSON. No markdown.`;
    try {
        const response = await callModel(evalModel, prompt);
        const parsed = JSON.parse(response);
        const score = Math.max(0, Math.min(10, parsed.score));
        return Math.round(score * 10) / 10;
    }
    catch (err) {
        console.warn('[modelab:evaluator] eval failed:', err);
        return 0;
    }
}
export async function callModel(config, prompt) {
    const apiKey = config.apiKey ?? getApiKey(config.provider);
    if (config.provider === 'ollama') {
        return callOllama(config, prompt);
    }
    if (config.provider === 'anthropic') {
        return callAnthropic(config, prompt, apiKey);
    }
    if (config.provider === 'minimax') {
        return callMinimax(config, prompt, apiKey);
    }
    if (config.provider === 'openrouter') {
        return callOpenRouter(config, prompt, apiKey);
    }
    // Default: OpenAI
    return callOpenAI(config, prompt, apiKey);
}
function getApiKey(provider) {
    if (provider === 'anthropic') {
        const k = process.env.ANTHROPIC_API_KEY;
        if (!k)
            throw new Error('ANTHROPIC_API_KEY not set');
        return k;
    }
    if (provider === 'minimax') {
        const k = process.env.MINIMAX_API_KEY;
        if (!k)
            throw new Error('MINIMAX_API_KEY not set');
        return k;
    }
    if (provider === 'openrouter') {
        const k = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
        if (!k)
            throw new Error('OPENROUTER_API_KEY or OPENAI_API_KEY not set');
        return k;
    }
    // openai / openai-compatible
    const k = process.env.OPENAI_API_KEY;
    if (!k)
        throw new Error('OPENAI_API_KEY not set');
    return k;
}
async function callOpenAI(config, prompt, apiKey) {
    const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    const model = config.model.startsWith('anthropic/')
        ? config.model.replace('anthropic/', '')
        : config.model;
    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: config.maxTokens ?? 512,
            temperature: config.temperature ?? 0,
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }
    const json = await res.json();
    return json.choices[0]?.message?.content ?? '';
}
async function callAnthropic(config, prompt, apiKey) {
    const baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';
    const model = config.model;
    const res = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            max_tokens: config.maxTokens ?? 1024,
            messages: [{ role: 'user', content: prompt }],
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }
    const json = await res.json();
    return json.content[0]?.text ?? '';
}
async function callOllama(config, prompt) {
    const baseUrl = config.baseUrl ?? 'http://localhost:11434';
    const res = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: config.model,
            prompt,
            stream: false,
            options: {
                temperature: config.temperature ?? 0.7,
                num_predict: config.maxTokens ?? 1024,
            },
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama error ${res.status}: ${text}`);
    }
    const json = await res.json();
    return json.response ?? '';
}
/**
 * MiniMax API — https://api.minimax.chat
 * Endpoint: POST /v1/text/chatcompletion_v2
 * Auth: Bearer token (MINIMAX_API_KEY env var)
 */
async function callMinimax(config, prompt, apiKey) {
    const baseUrl = config.baseUrl ?? 'https://api.minimax.chat';
    const res = await fetch(`${baseUrl}/v1/text/chatcompletion_v2`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: config.maxTokens ?? 1024,
            temperature: config.temperature ?? 0,
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`MiniMax API error ${res.status}: ${text}`);
    }
    const json = await res.json();
    const choice = json.choices?.[0];
    return choice?.messages?.[0]?.content ?? '';
}
/**
 * OpenRouter — https://openrouter.ai/api/v1
 * Endpoint: POST /chat/completions
 * Auth: Bearer token (OPENROUTER_API_KEY or OPENAI_API_KEY env var)
 */
async function callOpenRouter(config, prompt, apiKey) {
    const baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/darks0l/modelab',
            'X-Title': 'modelab',
        },
        body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: config.maxTokens ?? 1024,
            temperature: config.temperature ?? 0,
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter error ${res.status}: ${text}`);
    }
    const json = await res.json();
    return json.choices[0]?.message?.content ?? '';
}
//# sourceMappingURL=evaluator.js.map