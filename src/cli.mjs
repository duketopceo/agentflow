import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runScript } from './runtime.mjs';
import { Journal } from './journal.mjs';
import { adapters, getAdapter } from './adapters/index.mjs';

const USAGE = `agentflow — cross-harness dynamic workflows

usage:
  agentflow run <script.mjs> [--harness <name>] [--concurrency <n>]
                [--via ori] [--cache] [--resume <run-id>] [--grace <ms>]
                [--cwd <dir>]
                [-- <script args>...]
  agentflow doctor
  agentflow list

config: agentflow.json in cwd — {"harness": "devin", "concurrency": 8, "via": "ori"}
`;

function parseFlags(argv) {
  const flags = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { flags.scriptArgs = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[k] = next; i += 2; }
      else { flags[k] = true; i += 1; }
    } else if (a === '-c') { flags.concurrency = argv[++i]; i += 1; }
    else flags._.push(a), i += 1;
  }
  return flags;
}

function loadConfig(cwd) {
  try {
    const p = resolve(cwd, 'agentflow.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  } catch (e) {
    process.stderr.write(`agentflow: warning: agentflow.json unreadable: ${e.message}\n`);
    return {};
  }
}

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  const cwd = resolve(flags.cwd ?? process.cwd());
  const config = loadConfig(cwd);

  if (cmd === 'run') {
    const script = flags._[0];
    if (!script) { process.stderr.write(USAGE); return 2; }
    const harnessName = flags.harness ?? config.harness ?? 'devin';
    const adapter = getAdapter(harnessName);
    if (!adapter) {
      process.stderr.write(`agentflow: unknown harness '${harnessName}' (have: ${Object.keys(adapters).join(', ')})\n`);
      return 2;
    }
    const { code, runId } = await runScript({
      scriptPath: resolve(cwd, script),
      adapter,
      concurrency: Number(flags.concurrency ?? config.concurrency) || 8,
      cwd,
      args: flags.scriptArgs ?? [],
      via: flags.via ?? config.via ?? null,
      cache: !!(flags.cache || config.cache),
      resumeId: flags.resume ?? null,
      graceMs: flags.grace ? Number(flags.grace) : undefined,
    });
    if (runId) process.stderr.write(`[agentflow] run ${runId}\n`);
    return code;
  }

  if (cmd === 'doctor') {
    const probes = await Promise.all(Object.entries(adapters).map(async ([name, adapter]) => [name, await adapter.probe()]));
    let anyFail = false;
    for (const [name, p] of probes) {
      const mark = p.ok ? 'ok  ' : 'FAIL';
      if (!p.ok) anyFail = true;
      process.stdout.write(`${mark} ${name.padEnd(9)} ${p.path ?? '(not found)'}\n`);
      for (const n of p.notes ?? []) process.stdout.write(`     ${' '.repeat(9)} ${n}\n`);
    }
    return anyFail ? 1 : 0;
  }

  if (cmd === 'list') {
    const runs = Journal.list(cwd);
    if (!runs.length) { process.stdout.write('no runs under .agentflow/runs/\n'); return 0; }
    for (const r of runs) {
      process.stdout.write(`${r.runId}  ${r.script ?? '?'}  harness=${r.harness ?? '?'}  settled=${r.settled}  ${r.ended}\n`);
    }
    return 0;
  }

  process.stderr.write(USAGE);
  return cmd ? 2 : 0;
}
