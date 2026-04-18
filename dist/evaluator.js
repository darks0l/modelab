import { get_encoding } from 'tiktoken';
/**
 * Token estimator backed by tiktoken's gpt2 encoder — accurate BPE tokenization.
 * Lazy-initialized on first call; falls back to length/4 if tiktoken fails to load.
 * The sync fallback is used until the async encoder is ready (first few ms).
 */
let _encoder = null;
let _encoderReady = false;
function getEncoder() {
    if (_encoder)
        return _encoder;
    try {
        _encoder = get_encoding('gpt2');
        _encoderReady = true;
        return _encoder;
    }
    catch {
        _encoder = null;
        return null;
    }
}
/** Synchronous token estimate — uses BPE when available, length/4 as fallback.
 * This is the primary export; it is sync-safe and fast (< 1ms per call once warm).
 */
export function estimateTokens(text) {
    const enc = getEncoder();
    if (enc)
        return enc.encode(text).length;
    return Math.ceil(text.length / 4);
}
/** Async token estimate — always returns an accurate BPE count.
 * Use this in async contexts where you want the best accuracy from the first call.
 */
export async function estimateTokensAsync(text) {
    const enc = getEncoder();
    if (enc)
        return enc.encode(text).length;
    // tiktoken not yet loaded — do a sync init attempt then count
    try {
        const { get_encoding: ge } = await import('tiktoken');
        const e = ge('gpt2');
        _encoder = e;
        _encoderReady = true;
        return e.encode(text).length;
    }
    catch {
        return Math.ceil(text.length / 4);
    }
}
export async function callModel(config, prompt) {
    const result = await callModelFull(config, prompt);
    return result.output;
}
export async function callModelFull(config, prompt, apiKey) {
    const key = apiKey ?? getApiKey(config.provider);
    if (config.provider === 'ollama')
        return callOllama(config, prompt);
    if (config.provider === 'anthropic')
        return callAnthropic(config, prompt, key);
    if (config.provider === 'groq')
        return callGroq(config, prompt, key);
    if (config.provider === 'gemini')
        return callGemini(config, prompt, key);
    if (config.provider === 'perplexity')
        return callPerplexity(config, prompt, key);
    if (config.provider === 'minimax')
        return callMinimax(config, prompt, key);
    if (config.provider === 'openrouter')
        return callOpenRouter(config, prompt, key);
    return callOpenAI(config, prompt, key);
}
// ── Retry + Timeout helpers ──────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 60_000; // 60s
const STREAM_TIMEOUT_MS = 120_000; // 120s
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/**
 * Fetch with timeout + exponential backoff retry for transient errors.
 */
async function fetchWithRetry(url, options, opts = {}) {
    const { maxRetries = 3, initialDelayMs = 1000, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const composedSignal = signal
            ? anySignal(signal, controller.signal)
            : controller.signal;
        try {
            const res = await fetch(url, { ...options, signal: composedSignal });
            clearTimeout(timer);
            if (res.ok)
                return res;
            if (attempt < maxRetries && RETRYABLE_STATUS.has(res.status)) {
                const retryAfter = res.headers.get('Retry-After');
                const delay = retryAfter
                    ? parseInt(retryAfter, 10) * 1000
                    : initialDelayMs * 2 ** attempt + Math.random() * 500;
                console.warn(`[modelab:evaluator] ${res.status} — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
                await sleep(delay);
                continue;
            }
            return res;
        }
        catch (err) {
            clearTimeout(timer);
            if (attempt < maxRetries && isNetworkError(err)) {
                const delay = initialDelayMs * 2 ** attempt + Math.random() * 500;
                console.warn(`[modelab:evaluator] Network error — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries}): ${err}`);
                await sleep(delay);
                continue;
            }
            throw err;
        }
    }
    // Should not reach here, but satisfy TypeScript
    throw new Error('Max retries exceeded');
}
function anySignal(...signals) {
    const controller = new AbortController();
    for (const s of signals) {
        s.addEventListener('abort', () => controller.abort());
    }
    return controller.signal;
}
function isNetworkError(err) {
    if (err instanceof Error) {
        return (err.name === 'AbortError' ||
            err.name === 'TypeError' || // network failure
            err.message.includes('fetch') ||
            err.message.includes('network') ||
            err.message.includes('ECONNREFUSED') ||
            err.message.includes('ENOTFOUND'));
    }
    return false;
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// ── OpenAI ─────────────────────────────────────────────────────────────────
async function callOpenAI(cfg, prompt, apiKey) {
    const baseUrl = cfg.baseUrl ?? 'https://api.openai.com/v1';
    if (cfg.stream)
        return streamOpenAI(cfg, baseUrl, cfg.model, apiKey, prompt);
    const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: cfg.maxTokens ?? 512,
            temperature: cfg.temperature ?? 0,
            ...(cfg.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
    });
    if (!res.ok)
        throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return {
        output: json.choices[0]?.message?.content ?? '',
        inputTokens: json.usage?.prompt_tokens ?? estimateTokens(prompt),
        outputTokens: json.usage?.completion_tokens ?? 0,
        usage: json.usage,
    };
}
async function streamOpenAI(cfg, baseUrl, model, apiKey, prompt) {
    const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxTokens ?? 512, temperature: cfg.temperature ?? 0, stream: true, ...(cfg.jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
    }, { timeoutMs: STREAM_TIMEOUT_MS });
    if (!res.ok)
        throw new Error(`OpenAI error ${res.status}`);
    if (!res.body)
        throw new Error('No response body');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let output = '';
    let done = false;
    while (!done) {
        const { value, done: d } = await reader.read();
        done = d;
        if (value) {
            const chunk = dec.decode(value, { stream: !done });
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: '))
                    continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    done = true;
                    break;
                }
                try {
                    const p = JSON.parse(data);
                    const content = p.choices?.[0]?.delta?.content;
                    if (content) {
                        output += content;
                        cfg.stream(content);
                    }
                }
                catch { /* skip */ }
            }
        }
    }
    return { output, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(output) };
}
// ── Anthropic ──────────────────────────────────────────────────────────────
async function callAnthropic(cfg, prompt, apiKey) {
    const baseUrl = cfg.baseUrl ?? 'https://api.anthropic.com/v1';
    if (cfg.stream)
        return streamAnthropic(cfg, baseUrl, apiKey, prompt);
    const body = { model: cfg.model, max_tokens: cfg.maxTokens ?? 1024, messages: [{ role: 'user', content: prompt }] };
    if (cfg.jsonMode)
        body.output = { text: { annotations: true }, content: [{ type: 'text', text: '' }] };
    const res = await fetchWithRetry(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return {
        output: json.content[0]?.text ?? '',
        inputTokens: json.usage?.input_tokens ?? estimateTokens(prompt),
        outputTokens: json.usage?.output_tokens ?? 0,
    };
}
async function streamAnthropic(cfg, baseUrl, apiKey, prompt) {
    const body = { model: cfg.model, max_tokens: cfg.maxTokens ?? 1024, messages: [{ role: 'user', content: prompt }], stream: true };
    const res = await fetchWithRetry(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, { timeoutMs: STREAM_TIMEOUT_MS });
    if (!res.ok)
        throw new Error(`Anthropic error ${res.status}`);
    if (!res.body)
        throw new Error('No response body');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let output = '';
    let done = false;
    while (!done) {
        const { value, done: d } = await reader.read();
        done = d;
        if (value) {
            const chunk = dec.decode(value, { stream: !done });
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: '))
                    continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    done = true;
                    break;
                }
                try {
                    const p = JSON.parse(data);
                    const text = p.type === 'content_block' && 'text' in p ? p.text : p.delta?.text;
                    if (text) {
                        output += text;
                        cfg.stream(text);
                    }
                }
                catch { /* skip */ }
            }
        }
    }
    return { output, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(output) };
}
// ── Ollama ────────────────────────────────────────────────────────────────
async function callOllama(cfg, prompt) {
    const baseUrl = cfg.baseUrl ?? 'http://localhost:11434';
    const res = await fetchWithRetry(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, prompt, stream: false, options: { temperature: cfg.temperature ?? 0.7, num_predict: cfg.maxTokens ?? 1024 } }),
    });
    if (!res.ok)
        throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return {
        output: json.response ?? '',
        inputTokens: json.prompt_eval_count ?? estimateTokens(prompt),
        outputTokens: json.eval_count ?? estimateTokens(json.response ?? ''),
    };
}
// ── Groq ─────────────────────────────────────────────────────────────────
async function callGroq(cfg, prompt, apiKey) {
    const baseUrl = cfg.baseUrl ?? 'https://api.groq.com/openai/v1';
    const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxTokens ?? 1024, temperature: cfg.temperature ?? 0, ...(cfg.jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (!res.ok)
        throw new Error(`Groq error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return {
        output: json.choices[0]?.message?.content ?? '',
        inputTokens: json.usage?.prompt_tokens ?? estimateTokens(prompt),
        outputTokens: json.usage?.completion_tokens ?? 0,
        usage: json.usage,
    };
}
// ── Gemini ───────────────────────────────────────────────────────────────
async function callGemini(cfg, prompt, apiKey) {
    const baseUrl = cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const model = cfg.model.startsWith('models/') ? cfg.model : `models/${cfg.model}`;
    const res = await fetchWithRetry(`${baseUrl}/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: cfg.maxTokens ?? 1024, temperature: cfg.temperature ?? 0 } }),
    });
    if (!res.ok)
        throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const output = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return {
        output,
        inputTokens: json.usageMetadata?.promptTokenCount ?? estimateTokens(prompt),
        outputTokens: json.usageMetadata?.candidatesTokenCount ?? estimateTokens(output),
    };
}
// ── Perplexity ────────────────────────────────────────────────────────────
async function callPerplexity(cfg, prompt, apiKey) {
    const baseUrl = cfg.baseUrl ?? 'https://api.perplexity.ai';
    const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxTokens ?? 1024, temperature: cfg.temperature ?? 0 }),
    });
    if (!res.ok)
        throw new Error(`Perplexity error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return {
        output: json.choices[0]?.message?.content ?? '',
        inputTokens: json.usage?.prompt_tokens ?? estimateTokens(prompt),
        outputTokens: json.usage?.completion_tokens ?? 0,
        usage: json.usage,
    };
}
// ── MiniMax ───────────────────────────────────────────────────────────────
async function callMinimax(cfg, prompt, apiKey) {
    const baseUrl = cfg.baseUrl ?? 'https://api.minimax.chat';
    const res = await fetchWithRetry(`${baseUrl}/v1/text/chatcompletion_v2`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxTokens ?? 1024, temperature: cfg.temperature ?? 0 }),
    });
    if (!res.ok)
        throw new Error(`MiniMax error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const output = json.choices?.[0]?.messages?.[0]?.content ?? '';
    return { output, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(output) };
}
// ── OpenRouter ────────────────────────────────────────────────────────────
async function callOpenRouter(cfg, prompt, apiKey) {
    const baseUrl = cfg.baseUrl ?? 'https://openrouter.ai/api/v1';
    if (cfg.stream)
        return streamOpenAI(cfg, baseUrl, cfg.model, apiKey, prompt);
    const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/darks0l/modelab', 'X-Title': 'modelab' },
        body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: cfg.maxTokens ?? 1024, temperature: cfg.temperature ?? 0, ...(cfg.jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (!res.ok)
        throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return {
        output: json.choices[0]?.message?.content ?? '',
        inputTokens: json.usage?.prompt_tokens ?? estimateTokens(prompt),
        outputTokens: json.usage?.completion_tokens ?? 0,
        usage: json.usage,
    };
}
// ── API Key resolution ────────────────────────────────────────────────────
function getApiKey(provider) {
    const env = {
        anthropic: 'ANTHROPIC_API_KEY',
        minimax: 'MINIMAX_API_KEY',
        groq: 'GROQ_API_KEY',
        gemini: 'GEMINI_API_KEY',
        perplexity: 'PERPLEXITY_API_KEY',
    };
    const varName = env[provider];
    if (varName) {
        const k = process.env[varName];
        if (!k)
            throw new Error(`${varName} not set`);
        return k;
    }
    if (provider === 'openrouter') {
        const k = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
        if (!k)
            throw new Error('OPENROUTER_API_KEY or OPENAI_API_KEY not set');
        return k;
    }
    const k = process.env.OPENAI_API_KEY;
    if (!k)
        throw new Error('OPENAI_API_KEY not set');
    return k;
}
//# sourceMappingURL=evaluator.js.map