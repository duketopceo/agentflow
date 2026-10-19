import { extractJson, probeBinary, spawnProcess, classifyFailure, applyVia } from './base.mjs';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Verified against `codex exec --help`:
//   positional PROMPT, -m/--model, -s/--sandbox read-only|workspace-write|danger-full-access,
//   -C/--cd DIR, --worktree, --output-schema FILE, --json (JSONL events),
//   -o/--output-last-message FILE, --dangerously-bypass-approvals-and-sandbox,
//   --skip-git-repo-check.
// KTD7: default -s workspace-write; 'escalated' -> --dangerously-bypass-approvals-and-sandbox.
export default {
  name: 'codex',
  bin: 'codex',
  modelFlag: '-m',
  requiredFlags: ['exec', '--model', '--sandbox', '--output-schema', '--output-last-message', '--worktree'],
  permissionDeniedPatterns: [
    /permission (denied|required)/i,
    /approval (required|denied)/i,
    /requires approval/i,
    /sandbox.*denied/i,
  ],

  buildArgv(spec, ctx = {}) {
    const argv = [this.bin, 'exec'];
    if (spec.model) argv.push('-m', spec.model);
    if (spec.permission === 'escalated') argv.push('--dangerously-bypass-approvals-and-sandbox');
    else argv.push('-s', spec.permission === 'read-only' ? 'read-only' : 'workspace-write');
    if (spec.cwd) argv.push('-C', spec.cwd);
    if (spec.worktree) argv.push('--worktree');
    if (spec.schema && ctx.schemaFile) argv.push('--output-schema', ctx.schemaFile);
    if (ctx.lastMsgFile) argv.push('-o', ctx.lastMsgFile);
    // JSONL is the stable machine interface for usage; the last-message file
    // remains the user-facing result channel.
    argv.push('--json');
    argv.push('--skip-git-repo-check', spec.prompt);
    return argv;
  },

  async spawnAgent(spec) {
    const tmp = mkdtempSync(join(tmpdir(), 'agentflow-codex-'));
    try {
      const ctx = { lastMsgFile: join(tmp, 'last.txt') };
      if (spec.schema) {
        ctx.schemaFile = join(tmp, 'schema.json');
        writeFileSync(ctx.schemaFile, JSON.stringify(spec.schema));
      }
      const wrapped = applyVia(this, this.buildArgv(spec, ctx), spec);
      if (wrapped.error) {
        return { ok: false, error: { message: wrapped.error, stderrTail: '', code: null, timedOut: false, permissionDenied: false } };
      }
      const r = await spawnProcess(wrapped.argv, { cwd: spec.cwd, timeout: spec.timeout, signal: spec.signal });
      if (r.code === 0 && !r.timedOut) {
        const text = readText(ctx.lastMsgFile) ?? (r.stdout ?? '').trim();
        if (!text) return { ok: false, error: { message: 'empty result', stderrTail: r.stderr, code: 0, timedOut: false, permissionDenied: false } };
        const json = spec.schema ? extractJson(text) : null;
        if (spec.schema && json == null) return { ok: false, error: { message: 'schema: could not parse required JSON from output', stderrTail: r.stderr, code: 0, timedOut: false, permissionDenied: false } };
        const usage = extractUsage(r.stdout);
        return { ok: true, result: { text, json, ...(usage ? { usage } : {}) } };
      }
      return { ok: false, error: classifyFailure(r, this.permissionDeniedPatterns) };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },

  parse() { return null; }, // result captured via -o file in spawnAgent

  helpArgs: ['exec', '--help'],

  probe() {
    return probeBinary(this);
  },
};

function readText(p) {
  try { const t = readFileSync(p, 'utf8').trim(); return t || null; } catch { return null; }
}

// Codex emits usage as JSONL. Select the last cumulative event so streaming
// updates do not get double-counted. Unknown event shapes intentionally yield
// no usage rather than an estimate.
export function extractUsage(stdout) {
  let latest = null;
  for (const line of String(stdout ?? '').split('\n')) {
    try {
      const event = JSON.parse(line);
      const raw = event?.payload?.usage ?? event?.usage;
      if (raw && Number.isFinite(raw.input_tokens) && Number.isFinite(raw.output_tokens)) latest = raw;
    } catch {}
  }
  if (!latest) return null;
  const reasoningTokens = latest.reasoning_output_tokens ?? 0;
  return {
    promptTokens: latest.input_tokens,
    cachedTokens: latest.cached_input_tokens ?? 0,
    completionTokens: latest.output_tokens + reasoningTokens,
    inputTokens: latest.input_tokens,
    outputTokens: latest.output_tokens,
    reasoningTokens,
    totalTokens: latest.total_tokens ?? latest.input_tokens + latest.output_tokens,
  };
}
