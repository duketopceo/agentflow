import { extractJson, withSchemaPrompt, classifyFailure, batchResultMap } from './base.mjs';

// Direct OpenRouter /chat/completions call — no subprocess, no agent loop, no
// tools. The cheapest `agent()` surface: use for decompose/classify/verify/
// synthesize stages that only need reasoning over supplied text. Harness
// adapters (devin/claude/…) remain for stages that need files/tools.
// `batch()` calls use OR's async Batch API (submit → poll → per-custom_id
// results, ~40–60% off for ≤24h latency-tolerant work) via the batch()
// script global — see runtime.mjs.
// AGENTFLOW_OPENROUTER_BASE: base-URL override (tests stub the whole API
// over localhost; also usable for proxies).
const BASE = process.env.AGENTFLOW_OPENROUTER_BASE ?? 'https://openrouter.ai/api/v1';
const URL = `${BASE}/chat/completions`;
const BATCH_URL = `${BASE}/batches`;

const errResult = (message, { code = null, timedOut = false, permissionDenied = false } = {}) =>
  ({ ok: false, error: { message, stderrTail: '', code, timedOut, permissionDenied } });

const httpErr = (status, data) =>
  errResult(`openrouter: ${data?.error?.message ?? `HTTP ${status}`}`, { code: status, permissionDenied: status === 401 || status === 403 });

export default {
  name: 'openrouter',
  bin: null,
  requiredFlags: [],
  supportsBatch: true,

  // Pure for tests: request body given a (possibly schema-prompted) spec.
  buildBody(spec) {
    const body = {
      model: spec.model ?? 'z-ai/glm-5.3-flash',
      messages: [{ role: 'user', content: spec.prompt }],
    };
    if (spec.reasoningEffort) body.reasoning = { effort: spec.reasoningEffort };
    return body;
  },

  async spawnAgent(spec) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return errResult('openrouter: OPENROUTER_API_KEY not set');
    const s = withSchemaPrompt(spec);
    const signals = [AbortSignal.timeout(spec.timeout ?? 120_000)];
    if (spec.signal) signals.push(spec.signal);
    // spec.fetchImpl: test seam — fake responses without network. Same seam
    // serves the /batches client (batch plan).
    const doFetch = spec.fetchImpl ?? fetch;
    let r, data;
    try {
      r = await doFetch(URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildBody(s)),
        signal: AbortSignal.any(signals),
      });
      data = await r.json().catch(() => null);
    } catch (e) {
      return errResult(String(e?.message ?? e), { timedOut: e?.name === 'TimeoutError' });
    }
    if (!r.ok) return httpErr(r.status, data);
    const text = (data?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) return errResult('openrouter: empty completion', { code: 0 });
    return { ok: true, result: { text, json: spec.schema ? extractJson(text) : null } };
  },

  // Body for one batch item — same schema-prompt expansion as the sync path.
  batchBody(spec) {
    return this.buildBody(withSchemaPrompt(spec));
  },

  // Batch API: one async job per N requests. `items` are already-built
  // request bodies (batchBody output); submit keys them c0..cN. Uniform
  // model is the caller's job (runtime checks before calling).
  async submitBatch(model, items, spec = {}) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return errResult('openrouter: OPENROUTER_API_KEY not set');
    const requests = items.map((body, i) => ({ custom_id: `c${i}`, body }));
    let r, data;
    try {
      const signals = [AbortSignal.timeout(60_000)];
      if (spec.signal) signals.push(spec.signal);
      r = await (spec.fetchImpl ?? fetch)(BATCH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: '/v1/chat/completions', model, requests }),
        signal: AbortSignal.any(signals),
      });
      data = await r.json().catch(() => null);
    } catch (e) {
      return errResult(String(e?.message ?? e));
    }
    if (!r.ok) {
      const e = httpErr(r.status, data);
      e.error.message = `openrouter: batch submit (${model}): ${e.error.message.replace(/^openrouter: /, '')}`;
      return e;
    }
    if (!data?.id) return errResult('openrouter: batch submit returned no id', { code: 0 });
    return { ok: true, batchId: data.id, status: data.status };
  },

  async getBatch(id, spec = {}) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return errResult('openrouter: OPENROUTER_API_KEY not set');
    let r, data;
    try {
      // 30s per poll request — a stalled connection becomes a transient poll
      // failure the runtime retries, not a hang that outlives the deadline.
      const signals = [AbortSignal.timeout(30_000)];
      if (spec.signal) signals.push(spec.signal);
      r = await (spec.fetchImpl ?? fetch)(`${BATCH_URL}/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.any(signals),
      });
      data = await r.json().catch(() => null);
    } catch (e) {
      return errResult(String(e?.message ?? e));
    }
    if (!r.ok) return httpErr(r.status, data);
    return { ok: true, status: data?.status, results: data?.results ?? null, error: data?.error ?? null };
  },

  // Normalize whatever shape /batches returns for results into
  // Map custom_id -> response body (a chat-completions-shaped object).
  batchResultMap(results) {
    return batchResultMap(results);
  },

  // Turn one batch result entry (a chat-completions body) into the same
  // {text,json} shape spawnAgent produces.
  batchItemResult(entry, spec) {
    if (entry?.error) {
      return errResult(`openrouter: ${entry.error.message ?? 'item failed'}`, { code: entry.error.code ?? 0 });
    }
    const text = (entry?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) return { ok: false, error: { message: 'openrouter: empty completion', stderrTail: '', code: 0, timedOut: false, permissionDenied: false } };
    return { ok: true, result: { text, json: spec.schema ? extractJson(text) : null } };
  },

  async probe() {
    const ok = !!process.env.OPENROUTER_API_KEY;
    return {
      ok, name: 'openrouter', bin: null,
      notes: [ok ? 'OPENROUTER_API_KEY set — direct /chat/completions + /batches, no tools' : 'OPENROUTER_API_KEY not set'],
    };
  },
};
