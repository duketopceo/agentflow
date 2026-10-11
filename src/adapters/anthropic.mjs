import { extractJson, withSchemaPrompt, batchResultMap } from './base.mjs';

// Direct Anthropic /v1/messages call — no subprocess, no agent loop, no
// tools. The `claude` adapter wraps the claude CLI for agentic work; this
// adapter exists for the plain-completion stages and for `batch()`, which a
// synchronous CLI can never provide.
// `batch()` uses Anthropic's Message Batches API (~50% off, ≤24h window):
// one POST submits N requests; `ended` batches expose a `results_url`
// (JSONL per custom_id). `ended` is mapped to `completed` at this boundary
// — the runtime only understands the shared status vocabulary.
//
// Auth: ANTHROPIC_API_KEY env. AGENTFLOW_ANTHROPIC_BASE overrides the base
// for tests/proxies. `anthropic-beta: message-batches-2024-09-24` is sent
// on batch endpoints unconditionally — harmless if GA'd (verify at live
// gate; KTD4 of docs/plans/2026-10-11-002).
// Default model claude-haiku-4-5: cheap-tier placeholder, confirm on first
// live run. max_tokens is required by the API — default 8192, per-call
// override via { maxTokens }.
const BASE = process.env.AGENTFLOW_ANTHROPIC_BASE ?? 'https://api.anthropic.com';
const VERSION = '2023-06-01';
const BATCH_BETA = 'message-batches-2024-09-24';
const DEFAULT_MAX_TOKENS = 8192;

const errResult = (message, { code = null, timedOut = false, permissionDenied = false } = {}) =>
  ({ ok: false, error: { message, stderrTail: '', code, timedOut, permissionDenied } });

const headers = (key, batch = false) => ({
  'x-api-key': key,
  'anthropic-version': VERSION,
  ...(batch ? { 'anthropic-beta': BATCH_BETA } : {}),
  'Content-Type': 'application/json',
});

const httpErr = (status, data) =>
  errResult(`anthropic: ${data?.error?.message ?? `HTTP ${status}`}`, { code: status, permissionDenied: status === 401 || status === 403 });

async function call(url, { method = 'GET', body, signal, timeoutMs = 30_000, fetchImpl, batch = false, text = false } = {}, key) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let r, data;
  try {
    r = await (fetchImpl ?? fetch)(url, {
      method,
      headers: headers(key, batch),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any(signals),
    });
    data = text ? await r.text().catch(() => null) : await r.json().catch(() => null);
  } catch (e) {
    return errResult(String(e?.message ?? e), { timedOut: e?.name === 'TimeoutError' });
  }
  if (!r.ok) return httpErr(r.status, data);
  return { ok: true, data };
}

export default {
  name: 'anthropic',
  bin: null,
  requiredFlags: [],
  supportsBatch: true,

  buildBody(spec) {
    return {
      model: spec.model ?? 'claude-haiku-4-5',
      max_tokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: spec.prompt }],
    };
  },

  async spawnAgent(spec) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return errResult('anthropic: ANTHROPIC_API_KEY not set');
    const s = withSchemaPrompt(spec);
    const r = await call(`${BASE}/v1/messages`, { method: 'POST', body: this.buildBody(s), signal: spec.signal, timeoutMs: spec.timeout ?? 120_000, fetchImpl: spec.fetchImpl }, key);
    if (!r.ok) return r;
    const text = (r.data?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('').trim();
    if (!text) return errResult('anthropic: empty completion', { code: 0 });
    return { ok: true, result: { text, json: spec.schema ? extractJson(text) : null } };
  },

  // Body for one batch item — same shape as the sync call minus nothing;
  // params = {model, max_tokens, messages}. Runtime supplies custom_id.
  batchBody(spec) {
    return this.buildBody(withSchemaPrompt(spec));
  },

  // Message Batches: one submit for N requests — no file upload (OpenAI's
  // two-step is the other API's quirk).
  async submitBatch(model, items, spec = {}) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return errResult('anthropic: ANTHROPIC_API_KEY not set');
    const requests = items.map((params, i) => ({ custom_id: `c${i}`, params }));
    const r = await call(`${BASE}/v1/messages/batches`, { method: 'POST', body: { requests }, signal: spec.signal, timeoutMs: 60_000, fetchImpl: spec.fetchImpl, batch: true }, key);
    if (!r.ok) {
      r.error.message = `anthropic: batch submit (${model}): ${r.error.message.replace(/^anthropic: /, '')}`;
      return r;
    }
    if (!r.data?.id) return errResult('anthropic: batch submit returned no id', { code: 0 });
    return { ok: true, batchId: r.data.id, status: r.data.processing_status };
  },

  async getBatch(id, spec = {}) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return errResult('anthropic: ANTHROPIC_API_KEY not set');
    const r = await call(`${BASE}/v1/messages/batches/${encodeURIComponent(id)}`, { signal: spec.signal, fetchImpl: spec.fetchImpl, batch: true }, key);
    if (!r.ok) return r;
    const b = r.data ?? {};
    const rc = b.request_counts ?? {};
    const settled = (rc.succeeded ?? 0) + (rc.errored ?? 0) + (rc.expired ?? 0) + (rc.canceled ?? 0);
    const counts = { pending: rc.processing ?? null, settled, total: settled + (rc.processing ?? 0) };
    if (b.processing_status !== 'ended') {
      return { ok: true, status: b.processing_status ?? 'in_progress', counts, error: null };
    }
    // `ended` -> normalized `completed`; results are a separate fetch.
    const url = b.results_url;
    if (!url) return { ok: true, status: 'completed', counts, results: [] };
    const rr = await call(url, { signal: spec.signal, fetchImpl: spec.fetchImpl, batch: true, text: true }, key);
    if (!rr.ok) return rr;
    let parsed;
    try { parsed = (rr.data ?? '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); }
    catch { return errResult('anthropic: malformed results JSONL', { code: 0 }); }
    const results = parsed.map((entry) => {
      const cid = entry?.custom_id;
      const res = entry?.result ?? {};
      if (res.type === 'succeeded') return { custom_id: cid, result: res.message };
      return { custom_id: cid, result: { error: { message: res.error?.message ?? `item ${res.type ?? 'failed'}` } } };
    });
    return { ok: true, status: 'completed', counts, results };
  },

  batchResultMap(results) {
    return batchResultMap(results);
  },

  batchItemResult(entry, spec) {
    if (entry?.error) return errResult(`anthropic: ${entry.error.message ?? 'item failed'}`, { code: entry.error.code ?? 0 });
    const text = (entry?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('').trim();
    if (!text) return errResult('anthropic: empty completion', { code: 0 });
    return { ok: true, result: { text, json: spec.schema ? extractJson(text) : null } };
  },

  async probe() {
    const ok = !!process.env.ANTHROPIC_API_KEY;
    return {
      ok, name: 'anthropic', bin: null,
      notes: [ok ? 'ANTHROPIC_API_KEY set — direct /v1/messages + /v1/messages/batches, no tools' : 'ANTHROPIC_API_KEY not set'],
    };
  },
};
