import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/agentflow', import.meta.url));

// Spawn the real CLI; capture output and exit code. Detach is the one place
// the suite forks a real process — always against the echo adapter.
function cli(args, cwd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errOut = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (errOut += d));
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`cli timeout: ${args.join(' ')}\n${out}${errOut}`)); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err: errOut }); });
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'af-cli-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    write(name, src) { writeFileSync(join(dir, name), src); return name; },
  };
}

const SCRIPT = `export const meta = { name: 'w' };
phase('p');
const a = await agent('x', {label:'a'});
const b = await agent('y', {label:'b'});
log('RESULT:' + JSON.stringify([a.text, b.text]));`;

test('--detach: parent returns run-id immediately; child completes and journals', async () => {
  const f = fixture();
  try {
    f.write('w.mjs', SCRIPT);
    const t0 = Date.now();
    const r = await cli(['run', 'w.mjs', '--harness', 'echo', '--detach'], f.dir);
    assert.equal(r.code, 0);
    const runId = r.out.match(/run (\S+) \(detached/)?.[1];
    assert.ok(runId, `expected run id in output: ${r.out}`);
    assert.ok(Date.now() - t0 < 5000); // parent doesn't wait for the run

    // Child writes the journal + run-end on its own; status exits 2 while running.
    let status;
    for (let i = 0; i < 60; i++) {
      status = await cli(['status', runId], f.dir);
      if (status.code !== 2) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.equal(status.code, 0); // ended ok
    assert.ok(status.out.includes('a:ok') && status.out.includes('b:ok'));
    assert.ok(status.out.includes('ended: ok'));

    // tail on a finished run prints events and exits promptly.
    const tail = await cli(['tail', runId], f.dir, 8000);
    assert.equal(tail.code, 0);
    assert.ok(tail.out.includes('a -> ok') && tail.out.includes('run ended: ok'));

    // status on unknown run-id fails cleanly.
    const bad = await cli(['status', 'nope'], f.dir);
    assert.equal(bad.code, 2);
  } finally {
    f.cleanup();
  }
});

test('run --run-id honors a caller-provided run id', async () => {
  const f = fixture();
  try {
    f.write('w.mjs', SCRIPT);
    const r = await cli(['run', 'w.mjs', '--harness', 'echo', '--run-id', 'fixed-id-1'], f.dir);
    assert.equal(r.code, 0);
    assert.ok(existsSync(join(f.dir, '.agentflow', 'runs', 'fixed-id-1.jsonl')));
  } finally {
    f.cleanup();
  }
});

// Seed a journal directly — the unit under test is how the CLI reads it, so
// the run-start record is written by hand rather than booting a run.
function seedJournal(dir, runId, recs) {
  const runsDir = join(dir, '.agentflow', 'runs');
  mkdirSync(runsDir, { recursive: true });
  for (const rec of recs) appendFileSync(join(runsDir, `${runId}.jsonl`), JSON.stringify(rec) + '\n');
}

test('stop: live detached run reaches run-end via SIGTERM', async () => {
  const f = fixture();
  try {
    process.env.AGENTFLOW_ECHO_SLOW = '60000';
    f.write('w.mjs', `const r = await parallel([0,1,2].map(i => () => agent('do '+i, {label:'s'+i})));
log('done');`);
    const r = await cli(['run', 'w.mjs', '--harness', 'echo', '--detach'], f.dir);
    const runId = r.out.match(/run (\S+) \(detached/)?.[1];
    assert.ok(runId);
    // Wait for the child's journal to exist before signaling.
    const jpath = join(f.dir, '.agentflow', 'runs', `${runId}.jsonl`);
    for (let i = 0; i < 100 && !existsSync(jpath); i++) await new Promise((res) => setTimeout(res, 100));
    await new Promise((res) => setTimeout(res, 300)); // let calls reach in-flight

    const stop = await cli(['stop', runId], f.dir, 30000);
    assert.equal(stop.code, 0, stop.err);
    const status = await cli(['status', runId], f.dir);
    assert.ok(status.out.includes('ended: interrupted'), status.out);
  } finally {
    delete process.env.AGENTFLOW_ECHO_SLOW;
    f.cleanup();
  }
});

test('stop: ended run prints reason; unknown id exits 2', async () => {
  const f = fixture();
  try {
    f.write('w.mjs', SCRIPT);
    const r = await cli(['run', 'w.mjs', '--harness', 'echo', '--run-id', 'done-1'], f.dir);
    assert.equal(r.code, 0);
    const stop = await cli(['stop', 'done-1'], f.dir);
    assert.equal(stop.code, 0);
    assert.ok(stop.out.includes('already ended: ok'), stop.out);

    const bad = await cli(['stop', 'nope'], f.dir);
    assert.equal(bad.code, 2);
  } finally { f.cleanup(); }
});

test('orphan: dead-pid journal reads as orphaned in status/list/stop', async () => {
  const f = fixture();
  try {
    seedJournal(f.dir, 'orph-1', [
      { type: 'run-start', runId: 'orph-1', script: 'w.mjs', harness: 'echo', pid: 999999, at: new Date(Date.now() - 60000).toISOString() },
    ]);
    const status = await cli(['status', 'orph-1'], f.dir);
    assert.equal(status.code, 2);
    assert.ok(status.out.includes('orphaned'), status.out);
    assert.ok(status.out.includes('--resume orph-1'), status.out);

    const stop = await cli(['stop', 'orph-1'], f.dir);
    assert.equal(stop.code, 0);
    assert.ok(stop.out.includes('nothing to stop'), stop.out);

    const list = await cli(['list'], f.dir);
    assert.ok(list.out.includes('orph-1') && list.out.includes('orphaned'), list.out);
  } finally { f.cleanup(); }
});

test('stop: pid-reuse guard refuses a live process started after journal time', async () => {
  const f = fixture();
  const sleeper = spawn('sleep', ['60']);
  try {
    // Journal claims pid started 10s ago; sleeper started ~now -> mismatch.
    seedJournal(f.dir, 'reuse-1', [
      { type: 'run-start', runId: 'reuse-1', script: 'w.mjs', harness: 'echo', pid: sleeper.pid, at: new Date(Date.now() - 10000).toISOString() },
    ]);
    const stop = await cli(['stop', 'reuse-1'], f.dir);
    assert.equal(stop.code, 1);
    assert.ok(stop.err.includes('refusing to signal'), stop.err);
    // The unrelated process survived — kill would have thrown ESRCH.
    let alive = false;
    try { process.kill(sleeper.pid, 0); alive = true; } catch {}
    assert.ok(alive, 'pid-reuse guard failed: unrelated process was signaled');
  } finally {
    sleeper.kill('SIGKILL');
    f.cleanup();
  }
});

// A live pid whose cmdline contains 'agentflow' — pidState requires both
// liveness and an agentflow-shaped process before a run counts as running.
function fakeRunner(dir) {
  const file = join(dir, 'agentflow-sleeper.mjs');
  writeFileSync(file, 'setTimeout(() => {}, 60000)');
  const p = spawn(process.execPath, [file], { stdio: 'ignore' });
  return p;
}

test('clean: removes ended-run worktrees, keeps running runs, --all sweeps strays', async () => {
  const f = fixture();
  const sleeper = fakeRunner(f.dir);
  try {
    execFileSync('git', ['init', '-q'], { cwd: f.dir });
    execFileSync('git', ['-C', f.dir, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', f.dir, 'config', 'user.name', 't']);
    writeFileSync(join(f.dir, '.gitignore'), '.agentflow/\n');
    writeFileSync(join(f.dir, 'f.txt'), 'x');
    execFileSync('git', ['-C', f.dir, 'add', '.']);
    execFileSync('git', ['-C', f.dir, 'commit', '-qm', 'init']);

    // A completed run whose journal records one worktree; a live run whose
    // journal records another; one stray dir with no record at all.
    const wtEnded = join(f.dir, '.agentflow', 'worktrees', 'ended-1-0');
    const wtLive = join(f.dir, '.agentflow', 'worktrees', 'live-1-0');
    const wtStray = join(f.dir, '.agentflow', 'worktrees', 'stray');
    execFileSync('git', ['-C', f.dir, 'worktree', 'add', '--detach', wtEnded, 'HEAD']);
    execFileSync('git', ['-C', f.dir, 'worktree', 'add', '--detach', wtLive, 'HEAD']);
    mkdirSync(wtStray, { recursive: true });
    seedJournal(f.dir, 'ended-1', [
      { type: 'run-start', runId: 'ended-1', script: 'w.mjs', harness: 'echo', pid: 999999, at: new Date().toISOString() },
      { type: 'worktree', i: 0, label: 'a', path: wtEnded, root: f.dir, at: new Date().toISOString() },
      { type: 'run-end', reason: 'ok', at: new Date().toISOString() },
    ]);
    seedJournal(f.dir, 'live-1', [
      { type: 'run-start', runId: 'live-1', script: 'w.mjs', harness: 'echo', pid: sleeper.pid, at: new Date().toISOString() },
      { type: 'worktree', i: 0, label: 'a', path: wtLive, root: f.dir, at: new Date().toISOString() },
    ]);

    // Default clean: ended-run worktree gone, live + stray kept.
    const clean = await cli(['clean'], f.dir);
    assert.equal(clean.code, 0);
    assert.ok(!existsSync(wtEnded), 'ended-run worktree not removed');
    assert.ok(existsSync(wtLive), 'live-run worktree wrongly removed');
    assert.ok(clean.out.includes('keep'), clean.out);

    // --all: stray swept, live still kept (it has a journal record).
    const cleanAll = await cli(['clean', '--all'], f.dir);
    assert.equal(cleanAll.code, 0);
    assert.ok(!existsSync(wtStray), 'stray dir not swept');
    assert.ok(existsSync(wtLive), 'live-run worktree wrongly removed by --all');
  } finally {
    sleeper.kill('SIGKILL');
    f.cleanup();
  }
});

test('status: a resumed run (run-start after run-end) is not reported ended', async () => {
  const f = fixture();
  try {
    seedJournal(f.dir, 'res-1', [
      { type: 'run-start', runId: 'res-1', script: 'w.mjs', harness: 'echo', pid: 999999, at: new Date().toISOString() },
      { type: 'run-end', reason: 'ok', at: new Date().toISOString() },
      { type: 'run-start', runId: 'res-1', script: 'w.mjs', harness: 'echo', pid: 999999, at: new Date().toISOString() },
    ]);
    const status = await cli(['status', 'res-1'], f.dir);
    assert.equal(status.code, 2);
    assert.ok(status.out.includes('orphaned'), status.out); // dead pid epoch, not 'ended: ok'
    assert.ok(!status.out.includes('ended: ok'), status.out);
  } finally { f.cleanup(); }
});

test('stop: malformed run-start.at refuses to signal (NaN must not bypass)', async () => {
  const f = fixture();
  const sleeper = fakeRunner(f.dir);
  try {
    seedJournal(f.dir, 'bad-at', [
      { type: 'run-start', runId: 'bad-at', script: 'w.mjs', harness: 'echo', pid: sleeper.pid, at: 'not-a-date' },
    ]);
    const stop = await cli(['stop', 'bad-at'], f.dir);
    assert.equal(stop.code, 1);
    assert.ok(stop.err.includes('refusing to signal'), stop.err);
    let alive = false;
    try { process.kill(sleeper.pid, 0); alive = true; } catch {}
    assert.ok(alive, 'unverifiable pid was signaled');
  } finally {
    sleeper.kill('SIGKILL');
    f.cleanup();
  }
});

test('stop: a reused pid (non-agentflow process) is refused even when timestamp matches', async () => {
  const f = fixture();
  const sleeper = spawn('sleep', ['60']);
  try {
    seedJournal(f.dir, 'other-1', [
      { type: 'run-start', runId: 'other-1', script: 'w.mjs', harness: 'echo', pid: sleeper.pid, at: new Date().toISOString() },
    ]);
    const stop = await cli(['stop', 'other-1'], f.dir);
    assert.equal(stop.code, 1);
    assert.ok(stop.err.includes('refusing to signal'), stop.err);
    let alive = false;
    try { process.kill(sleeper.pid, 0); alive = true; } catch {}
    assert.ok(alive, 'unrelated process was signaled');
  } finally {
    sleeper.kill('SIGKILL');
    f.cleanup();
  }
});

test('tail: dead-pid run reports orphaned and exits instead of hanging', async () => {
  const f = fixture();
  try {
    seedJournal(f.dir, 'tail-orph', [
      { type: 'run-start', runId: 'tail-orph', script: 'w.mjs', harness: 'echo', pid: 999999, at: new Date().toISOString() },
    ]);
    const tail = await cli(['tail', 'tail-orph'], f.dir, 8000);
    assert.equal(tail.code, 2);
    assert.ok(tail.out.includes('orphaned'), tail.out);
  } finally { f.cleanup(); }
});

test('clean: journaled path outside .agentflow/worktrees/ is skipped, never deleted', async () => {
  const f = fixture();
  try {
    const victim = join(f.dir, 'precious');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'x');
    seedJournal(f.dir, 'evil-1', [
      { type: 'run-start', runId: 'evil-1', script: 'w.mjs', harness: 'echo', pid: 999999, at: new Date().toISOString() },
      { type: 'worktree', i: 0, label: 'a', path: victim, at: new Date().toISOString() },
      { type: 'run-end', reason: 'ok', at: new Date().toISOString() },
    ]);
    const clean = await cli(['clean'], f.dir);
    assert.equal(clean.code, 0);
    assert.ok(clean.out.includes('skip'), clean.out);
    assert.ok(existsSync(join(victim, 'keep.txt')), 'containment check failed: file outside worktrees deleted');
  } finally { f.cleanup(); }
});

test('clean: an orphaned (dead-pid) run\'s worktree is reclaimed', async () => {
  const f = fixture();
  try {
    execFileSync('git', ['init', '-q'], { cwd: f.dir });
    execFileSync('git', ['-C', f.dir, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', f.dir, 'config', 'user.name', 't']);
    writeFileSync(join(f.dir, 'f.txt'), 'x');
    execFileSync('git', ['-C', f.dir, 'add', '.']);
    execFileSync('git', ['-C', f.dir, 'commit', '-qm', 'init']);
    const wtOrphan = join(f.dir, '.agentflow', 'worktrees', 'orph-1-0');
    execFileSync('git', ['-C', f.dir, 'worktree', 'add', '--detach', wtOrphan, 'HEAD']);
    seedJournal(f.dir, 'orph-1', [
      { type: 'run-start', runId: 'orph-1', script: 'w.mjs', harness: 'echo', pid: 999999, at: new Date().toISOString() },
      { type: 'worktree', i: 0, label: 'a', path: wtOrphan, root: f.dir, at: new Date().toISOString() },
    ]);
    const clean = await cli(['clean'], f.dir);
    assert.equal(clean.code, 0);
    assert.ok(!existsSync(wtOrphan), 'orphaned run\'s worktree not reclaimed');
  } finally { f.cleanup(); }
});

test('clean --all from a repo subdirectory keeps registered worktrees, sweeps strays', async () => {
  const f = fixture();
  try {
    execFileSync('git', ['init', '-q'], { cwd: f.dir });
    execFileSync('git', ['-C', f.dir, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', f.dir, 'config', 'user.name', 't']);
    writeFileSync(join(f.dir, 'f.txt'), 'x');
    execFileSync('git', ['-C', f.dir, 'add', '.']);
    execFileSync('git', ['-C', f.dir, 'commit', '-qm', 'init']);
    const sub = join(f.dir, 'sub');
    mkdirSync(sub);
    const wtRegistered = join(f.dir, '.agentflow', 'worktrees', 'reg-1');
    const wtStray = join(f.dir, '.agentflow', 'worktrees', 'stray-1');
    execFileSync('git', ['-C', f.dir, 'worktree', 'add', '--detach', wtRegistered, 'HEAD']);
    mkdirSync(wtStray, { recursive: true });
    // No journal records under the subdir — registered-but-unjournaled must be kept.
    const clean = await cli(['clean', '--all'], sub);
    assert.equal(clean.code, 0);
    assert.ok(clean.out.includes('registered worktree'), clean.out);
    assert.ok(existsSync(wtRegistered), 'registered worktree wrongly removed');
    assert.ok(!existsSync(wtStray), 'stray dir not swept');
  } finally { f.cleanup(); }
});

test('run-id path traversal is rejected for status and --run-id', async () => {
  const f = fixture();
  try {
    const bad = await cli(['status', '../../tmp/evil'], f.dir);
    assert.equal(bad.code, 2);
    assert.ok(bad.err.includes('invalid run-id'), bad.err);
    f.write('w.mjs', `await agent('x');`);
    const run = await cli(['run', 'w.mjs', '--harness', 'echo', '--run-id', '../escape'], f.dir);
    assert.equal(run.code, 1);
    assert.ok(run.err.includes('invalid run-id'), run.err);
  } finally { f.cleanup(); }
});
