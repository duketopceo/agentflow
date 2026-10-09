import { extractJson, probeBinary, spawnProcess, classifyFailure } from './base.mjs';
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
      const argv = this.buildArgv(spec, ctx);
      const r = await spawnProcess(argv, { cwd: spec.cwd, timeout: spec.timeout, signal: spec.signal });
      if (r.code === 0 && !r.timedOut) {
        const text = readText(ctx.lastMsgFile) ?? (r.stdout ?? '').trim();
        if (!text) return { ok: false, error: { message: 'empty result', stderrTail: r.stderr, code: 0, timedOut: false, permissionDenied: false } };
        const json = spec.schema ? extractJson(text) : null;
        if (spec.schema && json == null) return { ok: false, error: { message: 'schema: could not parse required JSON from output', stderrTail: r.stderr, code: 0, timedOut: false, permissionDenied: false } };
        return { ok: true, result: { text, json } };
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
