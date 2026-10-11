import { extractJson, withSchemaPrompt, batchResultMap } from './base.mjs';

// Perplexity Sonar — grounded answers with web citations, no subprocess, no
// tools. The research surface: decompose on openrouter, gather here,
// synthesize anywhere. `batch()` uses the async Sonar API — one
// /v1/async/sonar request per item, polled by request id (the composite-id
// pattern devin uses; there is no one-job-of-N endpoint). Statuses are
// clean: CREATED/IN_PROGRESS -> COMPLETED | FAILED with `response`/
// `error_message`. Live-verified constraint (2026-10-11): async accepts
// ONLY `sonar-deep-research` — it is the batch model by design (long cited
// reports, ~1-4min/request). Sync agent() takes any sonar model.
// Sonar async is supported until 2026-09-27; the Agent API
// (/v1/responses — same submit/retrieve shape) is the migration path.
// AGENTFLOW_PERPLEXITY_BASE: base-URL override for tests/proxies.
const BASE = process.env.AGENTFLOW_PERPLEXITY_BASE ?? 'https://api.perplexity.ai';
const CHAT_URL = `${BASE}/chat/completions`;
const ASYNC_URL = `${BASE}/v1/async/sonar`;

const errResult = (message, { code = null, timedOut = false, permissionDenied = false } = {}) =>
  ({ ok: false, error: { message, stderrTail: '', code, timedOut, permissionDenied } });

const httpErr = (status, data) =>
  errResult(`perplexity: ${data?.error?.message ?? data?.message ?? `HTTP ${status}`}`, { code: status, permissionDenied: status === 401 || status === 403 });

async function apiFetch(url, { method = 'GET', body, signal, timeoutMs = 30_000, fetchImpl } = {}, key) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let r, data;
  try {
    r = await (fetchImpl ?? fetch)(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any(signals),
    });
    data = await r.json().catch(() => null);
  } catch (e) {
    return errResult(String(e?.message ?? e), { timedOut: e?.name === 'TimeoutError' });
  }
  if (!r.ok) return httpErr(r.status, data);
  return { ok: true, data };
}

export default {
  name: 'perplexity',
  bin: null,
  requiredFlags: [],
  supportsBatch: true,

  buildBody(spec) {
    const body = {
      model: spec.model ?? 'sonar',
      messages: [{ role: 'user', content: spec.prompt }],
    };
    if (spec.reasoningEffort) body.reasoning_effort = spec.reasoningEffort;
    return body;
  },

  async spawnAgent(spec) {
    const key = process.env.PERPLEXITY_API_KEY;
    if (!key) return errResult('perplexity: PERPLEXITY_API_KEY not set');
    const r = await apiFetch(CHAT_URL, {
      method: 'POST', timeoutMs: spec.timeout ?? 120_000,
      signal: spec.signal, fetchImpl: spec.fetchImpl,
      body: this.buildBody(withSchemaPrompt(spec)),
    }, key);
    if (!r.ok) return r;
    const text = (r.data?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) return errResult('perplexity: empty completion', { code: 0 });
    const result = { text, json: spec.schema ? extractJson(text) : null };
    // Grounded answers carry citations — keep them on the result (and in the
    // journal) so research stages can surface sources.
    if (Array.isArray(r.data?.citations) && r.data.citations.length) result.citations = r.data.citations;
    return { ok: true, result };
  },

  batchBody(spec) {
    return this.buildBody(withSchemaPrompt(spec));
  },

  // Async Sonar: one request per item → JSON slot list (same composite-id
  // pattern as devin). Submit body wraps the chat payload in `request`.
  async submitBatch(model, bodies, spec = {}) {
    const key = process.env.PERPLEXITY_API_KEY;
    if (!key) return errResult('perplexity: PERPLEXITY_API_KEY not set');
    const slots = await Promise.all(bodies.map(async (b) => {
      const r = await apiFetch(ASYNC_URL, {
        method: 'POST', timeoutMs: 60_000, signal: spec.signal, fetchImpl: spec.fetchImpl,
        body: { request: b },
      }, key);
      if (!r.ok) return { error: r.error.message };
      return r.data?.id ?? { error: 'perplexity: async submit returned no id' };
    }));
    if (slots.every((s) => s?.error)) return errResult(`perplexity: every async submit failed: ${slots[0].error}`);
    return { ok: true, batchId: JSON.stringify(slots), status: 'in_progress' };
  },

  async getBatch(batchId, spec = {}) {
    const key = process.env.PERPLEXITY_API_KEY;
    if (!key) return errResult('perplexity: PERPLEXITY_API_KEY not set');
    let slots;
    try { slots = JSON.parse(batchId); } catch { return errResult('perplexity: malformed batch id'); }
    const results = await Promise.all(slots.map(async (slot, i) => {
      const cid = `c${i}`;
      if (slot?.error) return { custom_id: cid, result: { error: { message: slot.error } } };
      if (typeof slot !== 'string') return { custom_id: cid, result: { error: { message: 'perplexity: malformed batch slot' } } };
      const r = await apiFetch(`${ASYNC_URL}/${encodeURIComponent(slot)}`, { signal: spec.signal, fetchImpl: spec.fetchImpl }, key);
      if (!r.ok) {
        // Dead request or auth failure: terminal per-item outcome.
        if (r.error.code === 404 || r.error.code === 410 || r.error.permissionDenied) {
          return { custom_id: cid, result: { error: { message: r.error.message } } };
        }
        return { custom_id: cid, pending: true };
      }
      const s = r.data;
      if (s.status === 'COMPLETED') {
        return { custom_id: cid, result: s.response ?? { error: { message: 'perplexity: COMPLETED with no response' } } };
      }
      if (s.status === 'FAILED') {
        return { custom_id: cid, result: { error: { message: s.error_message ?? 'request failed' } } };
      }
      return { custom_id: cid, pending: true }; // CREATED / IN_PROGRESS / unknown
    }));
    if (results.some((x) => x.pending)) return { ok: true, status: 'in_progress', results: null };
    return { ok: true, status: 'completed', results: results.map(({ custom_id, result }) => ({ custom_id, result })) };
  },

  batchResultMap(results) {
    return batchResultMap(results);
  },

  batchItemResult(entry, spec) {
    if (entry?.error) return errResult(`perplexity: ${entry.error.message ?? 'item failed'}`, { code: entry.error.code ?? 0 });
    const text = (entry?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) return errResult('perplexity: empty completion', { code: 0 });
    const result = { text, json: spec.schema ? extractJson(text) : null };
    if (Array.isArray(entry?.citations) && entry.citations.length) result.citations = entry.citations;
    return { ok: true, result };
  },

  async probe() {
    const ok = !!process.env.PERPLEXITY_API_KEY;
    return {
      ok, name: 'perplexity', bin: null,
      notes: [ok ? 'PERPLEXITY_API_KEY set — grounded /chat/completions + /v1/async/sonar batch' : 'PERPLEXITY_API_KEY not set'],
    };
  },
};
