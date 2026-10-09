import { extractJson, withSchemaPrompt, classifyFailure } from './base.mjs';

// Direct OpenRouter /chat/completions call — no subprocess, no agent loop, no
// tools. The cheapest `agent()` surface: use for decompose/classify/verify/
// synthesize stages that only need reasoning over supplied text. Harness
// adapters (devin/claude/…) remain for stages that need files/tools.
// NOT compatible with ':batch' model slugs — those use OR's async batch API
// (verified: DeepInfraBatchAdapter rejects chat/completions, 404).
const URL = 'https://openrouter.ai/api/v1/chat/completions';

export default {
  name: 'openrouter',
  bin: null,
  requiredFlags: [],

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
    if (!key) {
      return { ok: false, error: { message: 'openrouter: OPENROUTER_API_KEY not set', stderrTail: '', code: null, timedOut: false, permissionDenied: false } };
    }
    const s = withSchemaPrompt(spec);
    const signals = [AbortSignal.timeout(spec.timeout ?? 120_000)];
    if (spec.signal) signals.push(spec.signal);
    let r, data;
    try {
      r = await fetch(URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildBody(s)),
        signal: AbortSignal.any(signals),
      });
      data = await r.json().catch(() => null);
    } catch (e) {
      return { ok: false, error: { message: String(e?.message ?? e), stderrTail: '', code: null, timedOut: e?.name === 'TimeoutError', permissionDenied: false } };
    }
    if (!r.ok) {
      const msg = data?.error?.message ?? `HTTP ${r.status}`;
      return { ok: false, error: { message: `openrouter: ${msg}`, stderrTail: '', code: r.status, timedOut: false, permissionDenied: r.status === 401 || r.status === 403 } };
    }
    const text = (data?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) return { ok: false, error: { message: 'openrouter: empty completion', stderrTail: '', code: 0, timedOut: false, permissionDenied: false } };
    return { ok: true, result: { text, json: spec.schema ? extractJson(text) : null } };
  },

  async probe() {
    const ok = !!process.env.OPENROUTER_API_KEY;
    return {
      ok, name: 'openrouter', bin: null,
      notes: [ok ? 'OPENROUTER_API_KEY set — direct /chat/completions, no tools' : 'OPENROUTER_API_KEY not set'],
    };
  },
};
