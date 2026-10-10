// Reproducible live smoke matrix — one agentflow run per row (cheap-first).
// Usage: node scripts/smoke-harnesses.mjs [--json] [--only name,...] [--script path]
// Rows are cheap-first: stop after the first failure unless you opt out.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { adapters } from '../src/adapters/index.mjs';
import { which } from '../src/adapters/which.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = resolve(ROOT, 'bin/agentflow');
const TIMEOUT_MS = 120_000;
const CHEAP_MODEL = 'z-ai/glm-5.3-flash';

const ROWS = [
  { name: 'echo', harness: 'echo', spend: 'none' },
  { name: 'devin', harness: 'devin', model: 'swe-2-medium', spend: 'free (swe-2 tier)' },
  { name: 'ori', harness: 'ori', model: CHEAP_MODEL, spend: '~$0.01' },
  { name: 'openrouter', harness: 'openrouter', model: CHEAP_MODEL, spend: '~$0.01' },
  { name: 'claude-via-ori', harness: 'claude', via: 'ori', model: CHEAP_MODEL, spend: '~$0.01' },
  { name: 'codex-via-ori', harness: 'codex', via: 'ori', model: CHEAP_MODEL, spend: '~$0.01' },
  { name: 'opencode-via-ori', harness: 'opencode', via: 'ori', model: CHEAP_MODEL, spend: '~$0.01' },
];

export function parseArgs(argv) {
  const opts = { json: false, only: null, script: resolve(ROOT, 'examples/smoke.mjs') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--only' || a === '--script') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) { process.stderr.write(`smoke: ${a} needs a value\n`); process.exit(2); }
      if (a === '--only') opts.only = v.split(','); else opts.script = resolve(v);
    } else if (a.startsWith('--')) { process.stderr.write(`smoke: unknown flag ${a}\n`); process.exit(2); }
  }
  return opts;
}

export async function runRow(row, script) {
  const t0 = Date.now();
  // Probe every binary the row needs: the harness's own plus the via wrapper's.
  for (const name of [row.harness, row.via].filter(Boolean)) {
    const bin = adapters[name]?.bin;
    if (bin && !(await which(bin))) return { ...row, ok: false, latencyMs: 0, text: `FAIL (${bin} not on PATH)` };
  }
  const args = [BIN, 'run', script, '--harness', row.harness];
  if (row.via) args.push('--via', row.via);
  if (row.model) args.push('--', row.model);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  const latencyMs = Date.now() - t0;
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') return { ...row, ok: false, latencyMs, text: 'FAIL (timeout)' };
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const pong = /smoke -> .*PONG/m.test(out);
  const tail = out.trim().split('\n').filter(Boolean).pop() ?? '';
  return { ...row, ok: r.status === 0 && pong, latencyMs, text: pong ? 'PONG' : `FAIL (${tail.slice(0, 80)})` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const rows = ROWS.filter((r) => !opts.only || opts.only.includes(r.name));
  if (!rows.length) {
    process.stderr.write(`smoke: --only matched no rows (have: ${ROWS.map((r) => r.name).join(', ')})\n`);
    process.exit(2);
  }
  const results = [];
  for (const row of rows) {
    const res = await runRow(row, opts.script);
    results.push(res);
    if (!opts.json) {
      const inv = `agentflow run ${opts.script.split('/').pop()} --harness ${res.harness}${res.via ? ` --via ${res.via}` : ''}`;
      process.stdout.write(`| ${res.name} | \`${inv}\` | ${res.text} | ${(res.latencyMs / 1000).toFixed(1)}s | ${res.spend ?? '—'} |\n`);
    }
  }
  if (opts.json) process.stdout.write(JSON.stringify(results) + '\n');
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
