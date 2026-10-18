import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScript } from './runtime.mjs';
import { Journal } from './journal.mjs';
import { readJournal, foldState, renderFrame } from './watch.mjs';
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
  agentflow watch [run-id]         live view of a run (newest if no id)
  agentflow mcp                    MCP server over stdio (newline JSON-RPC)
  agentflow doctor
  agentflow list
  agentflow init                   create a minimal project configuration

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
      batchPollMs: Number(flags['batch-poll'] ?? config.batchPollMs) || undefined,
      batchTimeoutMs: Number(flags['batch-timeout'] ?? config.batchTimeoutMs) || undefined,
      resumeId: flags.resume ?? null,
      graceMs: flags.grace ? Number(flags.grace) : undefined,
    });
    if (runId) process.stderr.write(`[agentflow] run ${runId}\n`);
    return code;
  }

  if (cmd === 'init') return initCmd(cwd);

  if (cmd === 'status' && flags.watch) return watchCmd(cwd, flags._[0]);
  if (cmd === 'status') return statusCmd(cwd, flags._[0], false);
  if (cmd === 'tail') return statusCmd(cwd, flags._[0], true);
  if (cmd === 'stop') return stopCmd(cwd, flags._[0]);
  if (cmd === 'clean') return cleanCmd(cwd, flags);
  if (cmd === 'watch') return watchCmd(cwd, flags._[0]);

  if (cmd === 'mcp') {
    const { serve } = await import('./mcp.mjs');
    await serve({ cwd });
    return 0;
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
      const state = r.ended === null
        ? (['dead', 'reused'].includes(pidState(r)) ? 'orphaned' : 'incomplete')
        : r.ended;
      process.stdout.write(`${r.runId}  ${r.script ?? '?'}  harness=${r.harness ?? '?'}  settled=${r.settled}  ${state}\n`);
    }
    return 0;
  }

  process.stderr.write(USAGE);
  return cmd ? 2 : 0;
}

function initCmd(cwd) {
  const path = resolve(cwd, 'agentflow.json');
  if (existsSync(path)) {
    process.stdout.write('agentflow.json already exists; left unchanged\n');
    return 0;
  }
  writeFileSync(path, JSON.stringify({ harness: 'devin', concurrency: 8 }, null, 2) + '\n');
  process.stdout.write(`created ${path}\n`);
  return 0;
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
  process.stdout.write(`run ${runId} (detached, pid ${child.pid})\n  watch:  agentflow watch ${runId}\n  status: agentflow status ${runId}\n`);
  return 0;
}

const END_EXIT = { ok: 0, error: 1, interrupted: 130, 'determinism-lint': 1 };
const endCode = (rec) => (rec ? (END_EXIT[rec.reason] ?? 1) : 2);

async function statusCmd(cwd, runId, follow) {
  if (!runId) { process.stderr.write(USAGE); return 2; }
  let path;
  try { path = Journal.pathFor(cwd, runId); } catch (e) { process.stderr.write(`agentflow: ${e.message}\n`); return 2; }
  if (!existsSync(path)) { process.stderr.write(`agentflow: no journal for run '${runId}' under ${Journal.dirFor(cwd)}\n`); return 2; }

  if (!follow) {
    const meta = Journal.load(path);
    const s = meta.runStart ?? {};
    process.stdout.write(`run ${runId}  ${s.script ?? '?'}  harness=${s.harness ?? '?'}  at=${s.at ?? '?'}\n`);
    const cells = [...meta.settled.values()].map((r) => `${r.label}:${r.ok ? 'ok' : 'fail'}`);
    process.stdout.write(`settled=${meta.settled.size}${cells.length ? '  ' + cells.join('  ') : ''}\n`);
    if (meta.usage.calls) {
      const u = meta.usage;
      process.stdout.write(`tokens in=${u.promptTokens} out=${u.completionTokens}${u.cachedTokens ? ` cached=${u.cachedTokens}` : ''} across ${u.calls} call${u.calls === 1 ? '' : 's'}\n`);
    }
    if (meta.ended) {
      process.stdout.write(`ended: ${meta.ended.reason} at ${meta.ended.at}\n`);
      return endCode(meta.ended);
    }
    if (['dead', 'reused'].includes(pidState(s))) {
      // run-end may have landed since the load — recheck before declaring
      const again = Journal.load(path);
      if (again.ended) {
        process.stdout.write(`ended: ${again.ended.reason} at ${again.ended.at}\n`);
        return endCode(again.ended);
      }
      process.stdout.write(orphanNotice(s, runId) + '\n');
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
    for (const w of meta.worktrees) {
      const k = `w${w.i}`;
      if (!seen.has(k)) { seen.add(k); process.stdout.write(`[${w.i}] ${w.label} -> worktree ${w.path}\n`); }
    }
    for (const rec of meta.settled.values()) {
      if (!seen.has(rec.i)) { seen.add(rec.i); print(rec); }
    }
    if (meta.ended) { print(meta.ended); return endCode(meta.ended); }
    if (['dead', 'reused'].includes(pidState(meta.runStart))) {
      const again = Journal.load(path);
      if (again.ended) { print(again.ended); return endCode(again.ended); }
      process.stdout.write(orphanNotice(meta.runStart, runId) + '\n');
      return 2;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// One verifier for every pid consumer (KTD1 — the journal is user-writable
// data, never proof of ownership). States:
//   'dead'            — no such pid: the run is orphaned
//   'reused'          — pid alive but provably not ours (EPERM'd, non-
//                       agentflow cmdline, or start-time mismatch vs
//                       run-start.at): treat like dead but never signal
//   'live'            — verified ours: safe to report running / to signal
//   'live-unverified' — alive but unverifiable (no journal timestamp, or
//                       ps unavailable): report running, but refuse to signal
function pidState(rs) {
  const pid = rs?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM' ? 'reused' : 'dead'; }
  let cmdline = null;
  try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch {}
  if (cmdline !== null && !cmdline.includes('agentflow')) return 'reused';
  const at = Date.parse(rs.at);
  if (!Number.isFinite(at)) return 'live-unverified';
  try { if (Math.abs(procStartMs(pid) - at) > 5_000) return 'reused'; }
  catch { return 'live-unverified'; }
  return 'live';
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } // EPERM = exists, can't signal
}

// Process start time via elapsed seconds (ps -o etimes=); start ≈ now - etimes.
function procStartMs(pid) {
  const out = execFileSync('ps', ['-o', 'etimes=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const secs = Number(out);
  if (!out || !Number.isFinite(secs)) throw new Error(`no start time for pid ${pid}`);
  return Date.now() - secs * 1000;
}

const resumeHint = (rs, runId) => `resume: agentflow run ${rs?.script ?? '<script>'} --resume ${runId}`;
const orphanNotice = (rs, runId) => `orphaned (pid ${rs?.pid ?? '?'} dead — ${resumeHint(rs, runId)})`;

async function stopCmd(cwd, runId) {
  if (!runId) { process.stderr.write(USAGE); return 2; }
  let path;
  try { path = Journal.pathFor(cwd, runId); } catch (e) { process.stderr.write(`agentflow: ${e.message}\n`); return 2; }
  const meta = Journal.load(path);
  if (!meta.runStart) { process.stderr.write(`agentflow: no journal for run '${runId}' under ${Journal.dirFor(cwd)}\n`); return 2; }
  if (meta.ended) { process.stdout.write(`run ${runId} already ended: ${meta.ended.reason}\n`); return 0; }

  const rs = meta.runStart;
  const state = pidState(rs);
  if (state === 'dead') {
    process.stdout.write(`run ${runId} orphaned (pid ${rs.pid ?? '?'} dead — nothing to stop); ${resumeHint(rs, runId)}\n`);
    return 0;
  }
  if (state !== 'live') {
    process.stderr.write(`agentflow: refusing to signal pid ${rs.pid} — cannot verify it is this run's process (${state === 'reused' ? 'pid likely reused' : 'no verifiable timestamp'})\n`);
    return 1;
  }
  try { process.kill(rs.pid, 'SIGTERM'); }
  catch (e) {
    if (e.code !== 'ESRCH') { process.stderr.write(`agentflow: signal failed: ${e.message}\n`); return 1; }
    process.stdout.write(`pid ${rs.pid} exited before signal; checking journal\n`);
    rs.pid = null; // don't misreport a signal we never delivered
  }
  if (rs.pid !== null) process.stdout.write(`SIGTERM -> pid ${rs.pid}; waiting for run-end\n`);
  const waitMs = Math.max(25_000, (rs.graceMs ?? 8_000) + 15_000);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (Journal.load(path).ended) { process.stdout.write(`run ${runId} ended\n`); return 0; }
    if (rs.pid !== null && !pidAlive(rs.pid)) { process.stdout.write(`run ${runId} exited without run-end (orphaned)\n`); return 1; }
    await new Promise((r) => setTimeout(r, 250));
  }
  process.stderr.write(`agentflow: SIGTERM delivered; run ${runId} still draining past ${Math.round(waitMs / 1000)}s — poll: agentflow status ${runId}\n`);
  return 1;
}

// agentflow clean: remove journaled worktrees of runs that are not live
// (ended or orphaned — a live run's checkout is never touched, KTD2).
// --all also sweeps unrecorded dirs under <gitroot>/.agentflow/worktrees/.
// Journaled paths are user-writable data, not an rm -rf grant: every delete
// is contained to paths inside some .agentflow/worktrees/ dir.
function cleanCmd(cwd, flags) {
  let top = cwd;
  try { top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); } catch {}
  const wtRoot = join(top, '.agentflow', 'worktrees');
  const registered = new Set();
  try {
    for (const line of execFileSync('git', ['-C', top, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n'))
      if (line.startsWith('worktree ')) registered.add(line.slice(9));
  } catch {}
  const insideWtRoot = (p) => { try { return realpathSync(p).includes('/.agentflow/worktrees/'); } catch { return false; } };
  const journaled = new Set();
  const roots = new Set([top]);
  let removed = 0;
  const drop = (p, root = top) => {
    if (!insideWtRoot(p)) { process.stdout.write(`skip ${p} (outside .agentflow/worktrees/)\n`); return; }
    try {
      try { execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', p], { stdio: 'pipe' }); }
      catch { rmSync(p, { recursive: true, force: true }); } // stray dir, not a registered worktree
      removed++;
      process.stdout.write(`removed ${p}\n`);
    } catch (e) { process.stdout.write(`failed ${p}: ${e.message}\n`); }
  };
  for (const r of Journal.list(cwd)) {
    const live = r.ended === null && ['live', 'live-unverified'].includes(pidState(r));
    for (const w of r.worktrees ?? []) {
      journaled.add(w.path);
      roots.add(w.root ?? top);
      if (live) process.stdout.write(`keep ${w.path} (run ${r.runId} running)\n`);
      else if (existsSync(w.path)) drop(w.path, w.root ?? top);
    }
  }
  if (flags.all && existsSync(wtRoot)) {
    for (const d of readdirSync(wtRoot)) {
      const p = join(wtRoot, d);
      if (journaled.has(p)) continue;
      // registered-but-unjournaled may belong to a live run journaled under
      // another cwd — sweep only true strays, leave registrations to prune
      if (registered.has(p)) process.stdout.write(`keep ${p} (registered worktree, no journal record)\n`);
      else drop(p);
    }
  }
  for (const root of roots) {
    try { execFileSync('git', ['-C', root, 'worktree', 'prune'], { stdio: 'pipe' }); } catch {}
  }
  process.stdout.write(removed ? `removed ${removed} worktree(s)\n` : 'nothing to clean\n');
  return 0;
}

// Live run view. TTY: alternate-screen ANSI frame redrawn every 250ms from
// the journal event stream. Non-TTY: identical to `tail` (event lines).
// Read-only — Ctrl-C exits the view, never touches the run.
async function watchCmd(cwd, runId) {
  if (!runId) {
    const dir = Journal.dirFor(cwd);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort() : [];
    runId = files.at(-1)?.replace(/\.jsonl$/, '');
    if (!runId) { process.stderr.write(`agentflow: no runs under ${dir}\n`); return 2; }
  }
  const path = Journal.pathFor(cwd, runId);
  if (!existsSync(path)) { process.stderr.write(`agentflow: no journal for run '${runId}' under ${Journal.dirFor(cwd)}\n`); return 2; }
  if (!process.stdout.isTTY) return statusCmd(cwd, runId, true);

  process.stdout.write('\x1b[?1049h\x1b[?25l');
  let state, tick = 0;
  try {
    for (;;) {
      state = foldState(readJournal(path));
      process.stdout.write('\x1b[H' + renderFrame(state, {
        now: Date.now(), width: process.stdout.columns ?? 100, tick,
        pidAlive: state.done ? null : ['live', 'live-unverified'].includes(pidState(state.meta)),
      }));
      if (state.done) break;
      await new Promise((r) => setTimeout(r, 250));
      tick++;
    }
  } finally {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
  const settled = state ? [...state.lanes.values()].filter((l) => l.state === 'ok' || l.state === 'fail').length : 0;
  process.stdout.write(`run ${runId} ended: ${state.done?.reason ?? '?'} — settled ${settled}\n`);
  return endCode(state.done);
}
