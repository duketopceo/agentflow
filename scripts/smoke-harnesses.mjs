#!/usr/bin/env node
// Live adapter smoke runner — reproduces docs/smoke-matrix.md rows on demand.
// Per row: probe the harness binary, spawn `bin/agentflow run <script>
// --harness <h> [--via <v>] -- <model>` with a timeout, record pass/latency.
//
//   node scripts/smoke-harnesses.mjs [--only echo,ori] [--json] [--script <path>]
//
// Emits markdown table rows for docs/smoke-matrix.md (--json for machines).
// No secrets handled — env is inherited (OR rows need OPENROUTER_API_KEY set
// to the orchestral eval key per workspace rule, never openrouter/default).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = resolve(ROOT, 'bin/agentflow');
const TIMEOUT_MS = 120_000;

// Cheap-first matrix — mirrors the 2026-10-09 v0.2 smoke run. Models are the
// free/lowest-spend route per harness; no premium spend by default.
const ROWS = [
  { name: 'echo', harness: 'echo' },
  { name: 'devin', harness: 'devin', model: 'swe-2-medium' },
  { name: 'ori', harness: 'ori', model: 'z-ai/glm-5.3-flash' },
  { name: 'openrouter', harness: 'openrouter', model: 'z-ai/glm-5.3-flash' },
  { name: 'claude-via-ori', harness: 'claude', via: 'ori', model: 'z-ai/glm-5.3-flash' },
  { name: 'codex-via-ori', harness: 'codex', via: 'ori', model: 'z-ai/glm-5.3-flash' },
  { name: 'opencode-via-ori', harness: 'opencode', via: 'ori', model: 'z-ai/glm-5.3-flash' },
];

function parseArgs(argv) {
  const opts = { json: false, only: null, script: resolve(ROOT, 'examples/smoke.mjs') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--only') opts.only = argv[++i].split(',');
    else if (argv[i] === '--script') opts.script = resolve(argv[++i]);
  }
  return opts;
}

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Harnesses needing a CLI binary on PATH (echo runs in-process).
const PROBE_BIN = { devin: 'devin', claude: 'claude', codex: 'codex', opencode: 'opencode', ori: 'ori' };

function runRow(row, script) {
  const t0 = Date.now();
  const bin = PROBE_BIN[row.harness];
  if (bin && !which(bin)) {
    return { ...row, ok: false, latencyMs: 0, text: `FAIL (${bin} not on PATH)` };
  }
  const args = [BIN, 'run', script, '--harness', row.harness];
  if (row.via) args.push('--via', row.via);
  if (row.model) args.push('--', row.model);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: TIMEOUT_MS });
  const latencyMs = Date.now() - t0;
  if (r.error?.code === 'ETIMEDOUT') return { ...row, ok: false, latencyMs, text: 'FAIL (timeout)' };
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const pong = /PONG/i.test(out);
  const tail = out.trim().split('\n').filter(Boolean).pop() ?? '';
  return { ...row, ok: r.status === 0 && pong, latencyMs, text: pong ? 'PONG' : `FAIL (${tail.slice(0, 80)})` };
}

const opts = parseArgs(process.argv.slice(2));
const rows = ROWS.filter((r) => !opts.only || opts.only.includes(r.name));
const results = [];
for (const row of rows) {
  const res = runRow(row, opts.script);
  results.push(res);
  if (!opts.json) {
    const inv = `--harness ${res.harness}${res.via ? ` --via ${res.via}` : ''}${res.model ? ` -- ${res.model}` : ''}`;
    process.stdout.write(`| ${res.name} | \`${inv}\` | ${res.text} | ${(res.latencyMs / 1000).toFixed(1)}s |\n`);
  }
}
if (opts.json) process.stdout.write(JSON.stringify(results, null, 2) + '\n');
process.exit(results.every((r) => r.ok) ? 0 : 1);
