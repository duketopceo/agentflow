import { extractJson, withSchemaPrompt, batchResultMap } from './base.mjs';

// Direct OpenAI /v1/chat/completions call — no subprocess, no agent loop,
// no tools. The `codex` adapter wraps the codex CLI for agentic work; this
// adapter exists for the plain-completion stages and for `batch()`, which
// a synchronous CLI can never provide.
// `batch()` uses OpenAI's Batches API (~50% off, 24h window). Submit is
// two calls inside submitBatch: POST /v1/files (multipart JSONL upload,
// `purpose: 'batch'`) then POST /v1/batches {input_file_id, endpoint,
// completion_window:'24h'}. The journaled batch_id is the batch id — the
// file id is transient (a failed create orphans a harmless upload).
// `completed` batches expose output_file_id — getBatch fetches the JSONL
// ({custom_id, response:{status_code, body}, error}) and returns a
// normalized results array, so the runtime sees the same terminal shape
// as every other backend.
//
// Auth: OPENAI_API_KEY env. AGENTFLOW_OPENAI_BASE overrides the base for
// tests/proxies. Default model gpt-4.1-mini: cheap-tier placeholder,
// confirm on first live run (verify-at-implement-time list: KTD4 of
// docs/plans/2026-10-11-002 — multipart field names, expired-batch
// partial output ignored here).
const BASE = process.env.AGENTFLOW_OPENAI_BASE ?? 'https://api.openai.com';
const ENDPOINT = '/v1/chat/completions';

const errResult = (message, { code = null, timedOut = false, permissionDenied = false } = {}) =>
  ({ ok: false, error: { message, stderrTail: '', code, timedOut, permissionDenied } });

const httpErr = (status, data) =>
  errResult(`openai: ${data?.error?.message ?? `HTTP ${status}`}`, { code: status, permissionDenied: status === 401 || status === 403 });

async function call(url, { method = 'GET', body, headers = {}, signal, timeoutMs = 30_000, fetchImpl, text = false } = {}, key) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let r, data;
  try {
    r = await (fetchImpl ?? fetch)(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined),
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
  name: 'openai',
  bin: null,
  requiredFlags: [],
  supportsBatch: true,

  buildBody(spec) {
    return {
      model: spec.model ?? 'gpt-4.1-mini',
      messages: [{ role: 'user', content: spec.prompt }],
    };
  },

  async spawnAgent(spec) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return errResult('openai: OPENAI_API_KEY not set');
    const s = withSchemaPrompt(spec);
    const r = await call(`${BASE}${ENDPOINT}`, { method: 'POST', body: this.buildBody(s), signal: spec.signal, timeoutMs: spec.timeout ?? 120_000, fetchImpl: spec.fetchImpl }, key);
    if (!r.ok) return r;
    const text = (r.data?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) return errResult('openai: empty completion', { code: 0 });
    return { ok: true, result: { text, json: spec.schema ? extractJson(text) : null } };
  },

  batchBody(spec) {
    return this.buildBody(withSchemaPrompt(spec));
  },

  // Batches API: JSONL upload then batch create — one submitBatch call
  // does both; only the batch id is journaled.
  async submitBatch(model, items, spec = {}) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return errResult('openai: OPENAI_API_KEY not set');
    const jsonl = items.map((body, i) => JSON.stringify({ custom_id: `c${i}`, method: 'POST', url: ENDPOINT, body })).join('\n') + '\n';
    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch-input.jsonl');
    const up = await call(`${BASE}/v1/files`, { method: 'POST', body: form, signal: spec.signal, timeoutMs: 60_000, fetchImpl: spec.fetchImpl }, key);
    if (!up.ok) {
      up.error.message = `openai: batch file upload: ${up.error.message.replace(/^openai: /, '')}`;
      return up;
    }
    if (!up.data?.id) return errResult('openai: file upload returned no id', { code: 0 });
    const r = await call(`${BASE}/v1/batches`, {
      method: 'POST',
      body: { input_file_id: up.data.id, endpoint: ENDPOINT, completion_window: '24h' },
      signal: spec.signal, timeoutMs: 60_000, fetchImpl: spec.fetchImpl,
    }, key);
    if (!r.ok) {
      r.error.message = `openai: batch submit (${model}): ${r.error.message.replace(/^openai: /, '')}`;
      return r;
    }
    if (!r.data?.id) return errResult('openai: batch submit returned no id', { code: 0 });
    return { ok: true, batchId: r.data.id, status: r.data.status };
  },

  async getBatch(id, spec = {}) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return errResult('openai: OPENAI_API_KEY not set');
    const r = await call(`${BASE}/v1/batches/${encodeURIComponent(id)}`, { signal: spec.signal, fetchImpl: spec.fetchImpl }, key);
    if (!r.ok) return r;
    const b = r.data ?? {};
    const rc = b.request_counts ?? {};
    const settled = (rc.completed ?? 0) + (rc.failed ?? 0);
    const counts = { pending: (rc.total ?? 0) - settled, settled, total: rc.total ?? null };
    if (b.status !== 'completed') {
      return { ok: true, status: b.status ?? 'in_progress', counts, error: b.error ?? null };
    }
    const fileId = b.output_file_id;
    if (!fileId) return { ok: true, status: 'completed', counts, results: [] };
    const fr = await call(`${BASE}/v1/files/${encodeURIComponent(fileId)}/content`, { signal: spec.signal, fetchImpl: spec.fetchImpl, text: true }, key);
    if (!fr.ok) return fr;
    let lines;
    try { lines = (fr.data ?? '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); }
    catch { return errResult('openai: malformed output JSONL', { code: 0 }); }
    const results = lines.map((entry) => {
      const cid = entry?.custom_id;
      if (entry?.error) return { custom_id: cid, result: { error: { message: entry.error.message ?? 'item failed' } } };
      const resp = entry?.response ?? {};
      if ((resp.status_code ?? 200) >= 400) {
        return { custom_id: cid, result: { error: { message: resp.body?.error?.message ?? `HTTP ${resp.status_code}` } } };
      }
      return { custom_id: cid, result: resp.body };
    });
    return { ok: true, status: 'completed', counts, results };
  },

  batchResultMap(results) {
    return batchResultMap(results);
  },

  batchItemResult(entry, spec) {
    if (entry?.error) return errResult(`openai: ${entry.error.message ?? 'item failed'}`, { code: entry.error.code ?? 0 });
    const text = (entry?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) return errResult('openai: empty completion', { code: 0 });
    return { ok: true, result: { text, json: spec.schema ? extractJson(text) : null } };
  },

  async probe() {
    const ok = !!process.env.OPENAI_API_KEY;
    return {
      ok, name: 'openai', bin: null,
      notes: [ok ? 'OPENAI_API_KEY set — direct /v1/chat/completions + /v1/batches, no tools' : 'OPENAI_API_KEY not set'],
    };
  },
};
