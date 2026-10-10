import { readFileSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScript } from './runtime.mjs';
import { Journal } from './journal.mjs';
import { adapters, getAdapter } from './adapters/index.mjs';

const USAGE = `agentflow — cross-harness dynamic workflows

usage:
  agentflow run <script.mjs> [--harness <name>] [--concurrency <n>]
                [--via ori] [--cache] [--strict] [--max-agents <n>]
                [--retries <n>] [--resume <run-id>] [--grace <ms>]
                [--cwd <dir>] [--detach]
                [-- <script args>...]
  agentflow status <run-id>        progress + outcome from the journal
  agentflow tail <run-id>          stream journal events until run-end
  agentflow stop <run-id>          SIGTERM the journaled pid, wait for run-end
  agentflow clean [--all]          remove worktrees of ended runs
                                   (--all: also sweep unrecorded dirs)
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
    if (flags.detach) return detachRun(cwd, argv);

    const { code, runId } = await runScript({
      scriptPath: resolve(cwd, script),
      adapter,
      runId: flags['run-id'] ?? undefined,
      concurrency: Number(flags.concurrency ?? config.concurrency) || 8,
      cwd,
      args: flags.scriptArgs ?? [],
      via: flags.via ?? config.via ?? null,
      cache: !!(flags.cache || config.cache),
      strict: !!(flags.strict || config.strict),
      maxAgents: Number(flags['max-agents'] ?? config.maxAgents) || 1000,
      retries: Number(flags.retries ?? config.retries) || 0,
      resumeId: flags.resume ?? null,
      graceMs: flags.grace ? Number(flags.grace) : undefined,
    });
    if (runId) process.stderr.write(`[agentflow] run ${runId}\n`);
    return code;
  }

  if (cmd === 'status') return statusCmd(cwd, flags._[0], false);
  if (cmd === 'tail') return statusCmd(cwd, flags._[0], true);
  if (cmd === 'stop') return stopCmd(cwd, flags._[0]);
  if (cmd === 'clean') return cleanCmd(cwd, flags);

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
      const state = r.ended === 'incomplete' && !pidAlive(r.pid) ? 'orphaned' : r.ended;
      process.stdout.write(`${r.runId}  ${r.script ?? '?'}  harness=${r.harness ?? '?'}  settled=${r.settled}  ${state}\n`);
    }
    return 0;
  }

  process.stderr.write(USAGE);
  return cmd ? 2 : 0;
}

// --detach: respawn this CLI as a detached child with a parent-generated
// run-id, so the caller learns the id before the child boots. Child output
// appends to .agentflow/runs/<id>.log; the JSONL journal stays the record.
const SELF = fileURLToPath(new URL('../bin/agentflow', import.meta.url));

function detachRun(cwd, rawArgv) {
  const runId = Journal.newRunId();
  mkdirSync(Journal.dirFor(cwd), { recursive: true });
  const logFd = openSync(Journal.pathFor(cwd, runId).replace(/\.jsonl$/, '.log'), 'a');
  const childArgv = rawArgv.filter((a) => a !== '--detach');
  const dd = childArgv.indexOf('--'); // keep script args trailing
  const head = dd === -1 ? childArgv : childArgv.slice(0, dd);
  const tail = dd === -1 ? [] : childArgv.slice(dd);
  const args = [SELF, ...head, '--run-id', runId, '--cwd', cwd, ...tail];
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', logFd, logFd], cwd });
  child.unref();
  process.stdout.write(`run ${runId} (detached, pid ${child.pid})\n  watch:  agentflow tail ${runId}\n  status: agentflow status ${runId}\n`);
  return 0;
}

const END_EXIT = { ok: 0, error: 1, interrupted: 130, 'determinism-lint': 1 };
const endCode = (rec) => (rec ? (END_EXIT[rec.reason] ?? 1) : 2);

async function statusCmd(cwd, runId, follow) {
  if (!runId) { process.stderr.write(USAGE); return 2; }
  const path = Journal.pathFor(cwd, runId);
  if (!existsSync(path)) { process.stderr.write(`agentflow: no journal for run '${runId}' under ${Journal.dirFor(cwd)}\n`); return 2; }

  if (!follow) {
    const meta = Journal.load(path);
    const s = meta.runStart ?? {};
    process.stdout.write(`run ${runId}  ${s.script ?? '?'}  harness=${s.harness ?? '?'}  at=${s.at ?? '?'}\n`);
    const cells = [...meta.settled.values()].map((r) => `${r.label}:${r.ok ? 'ok' : 'fail'}`);
    process.stdout.write(`settled=${meta.settled.size}${cells.length ? '  ' + cells.join('  ') : ''}\n`);
    if (meta.ended) {
      process.stdout.write(`ended: ${meta.ended.reason} at ${meta.ended.at}\n`);
      return endCode(meta.ended);
    }
    if (!pidAlive(s.pid)) {
      process.stdout.write(`orphaned (pid ${s.pid ?? '?'} dead — resume: agentflow run ${s.script ?? '<script>'} --resume ${runId})\n`);
      return 2;
    }
    process.stdout.write(`running (pid ${s.pid})\n`);
    return 2;
  }

  const seen = new Set();
  const print = (rec) => {
    if (rec.type === 'run-start') process.stdout.write(`run started ${rec.script} harness=${rec.harness}\n`);
    else if (rec.type === 'agent') process.stdout.write(`[${rec.i}] ${rec.label} -> ${rec.ok ? 'ok' : 'fail'}${rec.model ? ` (${rec.model})` : ''}\n`);
    else if (rec.type === 'run-end') process.stdout.write(`run ended: ${rec.reason}\n`);
  };
  for (;;) {
    const meta = Journal.load(path);
    if (meta.runStart && !seen.has('s')) { seen.add('s'); print(meta.runStart); }
    for (const rec of meta.settled.values()) {
      if (!seen.has(rec.i)) { seen.add(rec.i); print(rec); }
    }
    if (meta.ended) { print(meta.ended); return endCode(meta.ended); }
    if (!pidAlive(meta.runStart?.pid)) {
      process.stdout.write(`orphaned (pid ${meta.runStart?.pid ?? '?'} dead — resume: agentflow run ${meta.runStart?.script ?? '<script>'} --resume ${runId})\n`);
      return 2;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// A journaled pid is ours to signal only while it is alive AND its start
// time matches run-start.at — a dead pid is an orphaned run, a mismatched
// live pid is someone else's process (pid reuse guard, KTD1).
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Process start time via elapsed seconds (ps -o etimes=); start ≈ now - etimes.
function procStartMs(pid) {
  const out = execFileSync('ps', ['-o', 'etimes=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const secs = Number(out);
  if (!Number.isFinite(secs)) throw new Error(`no start time for pid ${pid}`);
  return Date.now() - secs * 1000;
}

async function stopCmd(cwd, runId) {
  if (!runId) { process.stderr.write(USAGE); return 2; }
  const path = Journal.pathFor(cwd, runId);
  if (!existsSync(path)) { process.stderr.write(`agentflow: no journal for run '${runId}' under ${Journal.dirFor(cwd)}\n`); return 2; }
  const meta = Journal.load(path);
  if (!meta.runStart) { process.stderr.write(`agentflow: no journal for run '${runId}' under ${Journal.dirFor(cwd)}\n`); return 2; }
  if (meta.ended) { process.stdout.write(`run ${runId} already ended: ${meta.ended.reason}\n`); return 0; }

  const { pid, script } = meta.runStart;
  if (!pidAlive(pid)) {
    process.stdout.write(`run ${runId} orphaned (pid ${pid ?? '?'} dead — nothing to stop); resume: agentflow run ${script} --resume ${runId}\n`);
    return 0;
  }
  try {
    const skew = Math.abs(procStartMs(pid) - Date.parse(meta.runStart.at));
    if (skew > 5_000) {
      process.stderr.write(`agentflow: refusing to signal pid ${pid} — started ${(skew / 1000) | 0}s from journal time (pid likely reused)\n`);
      return 1;
    }
  } catch (e) {
    process.stderr.write(`agentflow: cannot verify pid ${pid} start time (${e.message}); refusing to signal\n`);
    return 1;
  }

  process.kill(pid, 'SIGTERM');
  process.stdout.write(`SIGTERM -> pid ${pid}; waiting for run-end\n`);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (Journal.load(path).ended) { process.stdout.write(`run ${runId} ended\n`); return 0; }
    await new Promise((r) => setTimeout(r, 250));
  }
  process.stderr.write(`agentflow: run ${runId} did not reach run-end within 25s\n`);
  return 1;
}

// agentflow clean: remove journaled worktrees of ENDED runs only (a live
// run's checkout is never touched, KTD2). --all also sweeps on-disk
// .agentflow/worktrees/ dirs with no journal record.
function cleanCmd(cwd, flags) {
  const wtRoot = join(cwd, '.agentflow', 'worktrees');
  const journaled = new Set();
  let removed = 0;
  const drop = (p) => {
    try { execFileSync('git', ['-C', cwd, 'worktree', 'remove', '--force', p], { stdio: 'pipe' }); }
    catch { rmSync(p, { recursive: true, force: true }); } // stray dir, not a registered worktree
    removed++;
    process.stdout.write(`removed ${p}\n`);
  };
  for (const r of Journal.list(cwd)) {
    if (r.ended === 'incomplete') {
      for (const w of Journal.load(Journal.pathFor(cwd, r.runId)).worktrees) {
        journaled.add(w.path);
        process.stdout.write(`keep ${w.path} (run ${r.runId} not ended)\n`);
      }
      continue;
    }
    for (const w of Journal.load(Journal.pathFor(cwd, r.runId)).worktrees) {
      journaled.add(w.path);
      if (existsSync(w.path)) drop(w.path);
    }
  }
  if (flags.all && existsSync(wtRoot)) {
    for (const d of readdirSync(wtRoot)) {
      const p = join(wtRoot, d);
      if (!journaled.has(p)) drop(p);
    }
  }
  process.stdout.write(removed ? `removed ${removed} worktree(s)\n` : 'nothing to clean\n');
  return 0;
}
