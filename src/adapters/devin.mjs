import { readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnAgent as run, extractJson, probeBinary, withSchemaPrompt, batchResultMap } from './base.mjs';

// Verified against `devin --help` (3000.11.3):
//   -p/--print [PROMPT], --permission-mode auto|accept-edits|smart|dangerous,
//   --model, --sandbox, --respect-workspace-trust false (required headless in
//   untrusted dirs), --export, --cloud.
// KTD7: default 'smart' (auto-runs actions a fast model judges safe);
// 'escalated' -> 'dangerous'. 'auto' alone is read-only — too weak for coding.
const PERMISSION_MAP = { escalated: 'dangerous', smart: 'smart', auto: 'auto', 'accept-edits': 'accept-edits', dangerous: 'dangerous' };

// Devin Cloud sessions API — the async-job surface batch() uses on this
// harness. Each item is one POST /v3/organizations/{org}/sessions; the
// session's `structured_output` field is the completion signal (sessions
// idle at `waiting_for_user` once the answer is produced — they do not
// self-terminate on output). Poll until every item resolves. Verified live
// 2026-10-10: swe-2-medium session produced structured_output in ~15s at
// 0.0 ACUs (free tier); status flow new -> running(waiting_for_user).
//
// Auth: DEVIN_API_KEY + DEVIN_ORG_ID env, else the CLI's own credentials
// (~/.local/share/devin/credentials.toml windsurf_api_key +
// ~/.config/devin/config.json devin.org_id).
// AGENTFLOW_DEVIN_BASE overrides the API base for tests/proxies.
const DEVIN_BASE = process.env.AGENTFLOW_DEVIN_BASE ?? 'https://api.devin.ai';
const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
// Statuses where the item's wait is over. A session with structured_output
// is collected regardless (output check runs first); any of these WITHOUT
// output means no output is coming — suspended sessions never wake alone.
const TERMINAL = new Set(['error', 'expired', 'terminated', 'killed', 'exit', 'suspended']);

function cloudAuth() {
  const home = homedir();
  let key = process.env.DEVIN_API_KEY;
  let org = process.env.DEVIN_ORG_ID;
  if (!key) {
    try {
      const toml = readFileSync(join(home, '.local/share/devin/credentials.toml'), 'utf8');
      key = /windsurf_api_key\s*=\s*"([^"]+)"/.exec(toml)?.[1];
    } catch { /* not signed in via CLI */ }
  }
  if (!org) {
    try {
      org = JSON.parse(readFileSync(join(home, '.config/devin/config.json'), 'utf8'))?.devin?.org_id;
    } catch { /* no config */ }
  }
  return key && org ? { key, org } : null;
}

const errResult = (message, { code = null, timedOut = false, permissionDenied = false } = {}) =>
  ({ ok: false, error: { message, stderrTail: '', code, timedOut, permissionDenied } });

// `--export` writes the session transcript including `final_metrics` (real
// token counts) — the cost-monitor feed. Path is internal (`spec._export`,
// not a script-facing opt); read after exit, deleted after read. Under
// --sandbox the export write may be denied — usage just comes back null.
// Captured on failures too: a runaway session is where spend hides.
let exportCounter = 0;
function readExportUsage(path) {
  let fm = null;
  try { fm = JSON.parse(readFileSync(path, 'utf8'))?.final_metrics; } catch { /* no/partial export */ }
  try { rmSync(path, { force: true }); } catch { /* best effort */ }
  if (!fm) return null;
  return {
    promptTokens: fm.total_prompt_tokens ?? null,
    completionTokens: fm.total_completion_tokens ?? null,
    cachedTokens: fm.total_cached_tokens ?? null,
    steps: fm.total_steps ?? null,
  };
}

async function apiFetch(path, { method = 'GET', body, signal, timeoutMs = 30_000, fetchImpl } = {}, auth) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let r, data;
  try {
    r = await (fetchImpl ?? fetch)(`${DEVIN_BASE}/v3/organizations/${auth.org}${path}`, {
      method,
      headers: { Authorization: `Bearer ${auth.key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any(signals),
    });
    data = await r.json().catch(() => null);
  } catch (e) {
    return errResult(String(e?.message ?? e));
  }
  if (!r.ok) {
    return errResult(`devin: ${data?.error?.message ?? data?.message ?? `HTTP ${r.status}`}`, { code: r.status, permissionDenied: r.status === 401 || r.status === 403 });
  }
  return { ok: true, data };
}

export default {
  name: 'devin',
  bin: 'devin',
  modelFlag: '--model',
  requiredFlags: ['--print', '--permission-mode', '--model', '--respect-workspace-trust'],
  supportsBatch: true,
  permissionDeniedPatterns: [
    /permission (denied|required)/i,
    /approval (required|denied)/i,
    /requires approval/i,
    /workspace trust/i,
    /untrusted (directory|workspace)/i,
  ],

  buildArgv(spec) {
    const argv = [this.bin, '-p', spec.prompt, '--respect-workspace-trust', 'false', '--permission-mode', PERMISSION_MAP[spec.permission] ?? 'smart'];
    if (spec.model) argv.push('--model', spec.model);
    if (spec.sandbox) argv.push('--sandbox');
    if (spec._export) argv.push('--export', spec._export);
    return argv;
  },

  // No native structured-output flag: enforce schema via prompt, extract after.
  async spawnAgent(spec) {
    const exportPath = join(tmpdir(), `af-devin-${process.pid}-${exportCounter++}.json`);
    const r = await run(this, { ...withSchemaPrompt(spec), _export: exportPath });
    const usage = readExportUsage(exportPath);
    if (usage) (r.ok ? r.result : r.error).usage = usage;
    return r;
  },

  parse(r, spec) {
    const text = (r.stdout ?? '').trim();
    if (!text) return null;
    return { text, json: spec.schema ? extractJson(text) : null };
  },

  // batch(): one cloud session per item. Bodies carry prompt/model/schema;
  // sessions get native structured_output (the {answer} envelope when the
  // item has no schema of its own).
  batchBody(spec) {
    return { prompt: spec.prompt, label: spec.label, model: spec.model ?? 'swe-2-medium', schema: spec.schema ?? null };
  },

  async submitBatch(model, bodies, spec = {}) {
    const auth = cloudAuth();
    if (!auth) return errResult('devin: no cloud credentials (set DEVIN_API_KEY + DEVIN_ORG_ID, or `devin auth login`)');
    const slots = await Promise.all(bodies.map(async (b) => {
      const r = await apiFetch('/sessions', {
        method: 'POST', timeoutMs: 60_000, signal: spec.signal, fetchImpl: spec.fetchImpl,
        body: {
          prompt: b.prompt,
          title: `agentflow batch: ${b.label ?? String(b.prompt).slice(0, 50)}`,
          tags: ['agentflow:batch'],
          devin_mode: b.model ?? model,
          structured_output_required: true,
          structured_output_schema: b.schema ?? ANSWER_SCHEMA,
        },
      }, auth);
      if (!r.ok) return { error: r.error.message };
      return r.data?.session_id ?? { error: 'devin: session submit returned no id' };
    }));
    if (slots.every((s) => s?.error)) return errResult(`devin: every session submit failed: ${slots[0].error}`);
    // Opaque composite id — a JSON slot list (session ids or per-item errors).
    return { ok: true, batchId: JSON.stringify(slots), status: 'in_progress' };
  },

  async getBatch(batchId, spec = {}) {
    const auth = cloudAuth();
    if (!auth) return errResult('devin: no cloud credentials (set DEVIN_API_KEY + DEVIN_ORG_ID, or `devin auth login`)');
    let slots;
    try { slots = JSON.parse(batchId); } catch { return errResult('devin: malformed batch id'); }
    const results = await Promise.all(slots.map(async (slot, i) => {
      const cid = `c${i}`;
      if (slot?.error) return { custom_id: cid, result: { error: { message: slot.error } } };
      if (typeof slot !== 'string') return { custom_id: cid, result: { error: { message: 'devin: malformed batch slot' } } };
      const r = await apiFetch(`/sessions/${slot}`, { signal: spec.signal, fetchImpl: spec.fetchImpl }, auth);
      if (!r.ok) {
        // Dead session or auth failure: terminal per-item outcome, not a
        // reason to keep polling. Transient 5xx stays pending → re-poll.
        if (r.error.code === 404 || r.error.code === 410 || r.error.permissionDenied) {
          return { custom_id: cid, result: { error: { message: r.error.message } } };
        }
        return { custom_id: cid, pending: true };
      }
      const s = r.data;
      if (s.structured_output != null) return { custom_id: cid, result: { structured_output: s.structured_output } };
      if (TERMINAL.has(s.status)) return { custom_id: cid, result: { error: { message: `session ${s.status}${s.status_detail ? ` (${s.status_detail})` : ''} without output` } } };
      return { custom_id: cid, pending: true };
    }));
    const pending = results.filter((x) => x.pending).length;
    const counts = { total: slots.length, settled: slots.length - pending, pending };
    if (pending) return { ok: true, status: 'in_progress', results: null, counts };
    return { ok: true, status: 'completed', results: results.map(({ custom_id, result }) => ({ custom_id, result })), counts };
  },

  batchResultMap(results) {
    return batchResultMap(results);
  },

  batchItemResult(entry, spec) {
    if (entry?.error) return errResult(`devin: ${entry.error.message ?? 'item failed'}`, { code: entry.error.code ?? 0 });
    const so = entry?.structured_output;
    if (so == null) return errResult('devin: session produced no structured_output', { code: 0 });
    const text = typeof so === 'object' ? (so.answer ?? JSON.stringify(so)) : String(so);
    return { ok: true, result: { text, json: spec.schema ? so : null } };
  },

  probe() { return probeBinary(this); },
};
