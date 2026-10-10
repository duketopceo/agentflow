import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScript } from '../src/runtime.mjs';
import { Journal } from '../src/journal.mjs';
import echo, { calls } from '../src/adapters/echo.mjs';
import { spawnAgent } from '../src/adapters/base.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'af-rt-'));
  const scriptPath = join(dir, 'w.mjs');
  const lines = [];
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return {
    dir,
    lines,
    cleanup,
    writeScript(src) { writeFileSync(scriptPath, src); return scriptPath; },
    async run(extra = {}) {
      calls.length = 0;
      return runScript({
        scriptPath, adapter: echo, cwd: dir, concurrency: 2,
        err: (s) => lines.push(s), ...extra,
      });
    },
    lastResult() {
      const line = lines.findLast((l) => l.includes('RESULT:'));
      return line ? JSON.parse(line.split('RESULT:')[1]) : undefined;
    },
  };
}

test('happy path: 5 parallel agent() calls complete in order', async () => {
  const f = fixture();
  try {
    f.writeScript(`export const meta = { name: 't' };
const r = await parallel([0,1,2,3,4].map(i => () => agent('do '+i, {label:'a'+i})));
log('RESULT:' + JSON.stringify(r));`);
    const res = await f.run();
    assert.equal(res.code, 0);
    const r = f.lastResult();
    assert.equal(r.length, 5);
    for (let i = 0; i < 5; i++) assert.match(r[i].text, new RegExp(`echo\\[a${i}\\]: do ${i}`));
    assert.equal(calls.length, 5);
  } finally { f.cleanup(); }
});

test('parallel() preserves null slots on failure', async () => {
  const f = fixture();
  try {
    process.env.AGENTFLOW_ECHO_FAIL = 'bad';
    f.writeScript(`const r = await parallel([
  () => agent('one', {label:'ok1'}),
  () => agent('two', {label:'bad-1'}),
  () => agent('three', {label:'ok2'}),
]);
log('RESULT:' + JSON.stringify(r));`);
    const res = await f.run();
    assert.equal(res.code, 0);
    const r = f.lastResult();
    assert.equal(r.length, 3);
    assert.match(r[0].text, /ok1/);
    assert.equal(r[1], null);
    assert.match(r[2].text, /ok2/);
  } finally { delete process.env.AGENTFLOW_ECHO_FAIL; f.cleanup(); }
});

test('pipeline() runs stages per item, null short-circuits', async () => {
  const f = fixture();
  try {
    f.writeScript(`const r = await pipeline(['x','y'],
  async (v) => agent('stage1 '+v, {label:'s1-'+v}),
  async (prev) => agent('stage2 '+prev.text.slice(0,20), {label:'s2-'+v0(prev)}),
);
function v0(p){ return p.text.includes('x') ? 'x' : 'y'; }
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const res = await f.run();
    assert.equal(res.code, 0);
    const r = f.lastResult();
    assert.equal(r.length, 2);
    assert.match(r[0], /echo\[s2-x\]/);
    assert.match(r[1], /echo\[s2-y\]/);
  } finally { f.cleanup(); }
});

test('schema option returns parsed json; parse failure returns null', async () => {
  const f = fixture();
  try {
    f.writeScript(`const ok = await agent('structured', {label:'s', schema:{type:'object'}});
const bad = await agent('structured', {label:'bad-schema', schema:{type:'object'}});
log('RESULT:' + JSON.stringify({ok: ok && ok.json, bad}));`);
    process.env.AGENTFLOW_ECHO_FAIL = 'bad-schema'; // simulate unparseable via adapter failure
    const res = await f.run();
    assert.equal(res.code, 0);
    const r = f.lastResult();
    assert.deepEqual(r.ok, { echo: 's' });
    assert.equal(r.bad, null);
  } finally { delete process.env.AGENTFLOW_ECHO_FAIL; f.cleanup(); }
});

test('timeout returns null and journals timedOut', async () => {
  const f = fixture();
  try {
    process.env.AGENTFLOW_ECHO_SLOW = '200';
    f.writeScript(`const r = await agent('slow', {label:'slow', timeout: 50});
log('RESULT:' + JSON.stringify(r));`);
    const res = await f.run();
    assert.equal(res.code, 0);
    assert.equal(f.lastResult(), null);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.equal(loaded.settled.get(0).error.timedOut, true);
  } finally { delete process.env.AGENTFLOW_ECHO_SLOW; f.cleanup(); }
});

test('permission denial is distinguished in journal error', async () => {
  const f = fixture();
  try {
    process.env.AGENTFLOW_ECHO_DENY = 'deny';
    f.writeScript(`const r = await agent('x', {label:'deny-1'});
log('RESULT:' + JSON.stringify(r));`);
    const res = await f.run();
    assert.equal(res.code, 0);
    assert.equal(f.lastResult(), null);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.equal(loaded.settled.get(0).error.permissionDenied, true);
  } finally { delete process.env.AGENTFLOW_ECHO_DENY; f.cleanup(); }
});

test('unknown agent() options warn but do not fail', async () => {
  const f = fixture();
  try {
    f.writeScript(`const r = await agent('x', {label:'a', bogusOpt: 1});
log('RESULT:' + JSON.stringify(r !== null));`);
    const res = await f.run();
    assert.equal(res.code, 0);
    assert.equal(f.lastResult(), true);
    assert.ok(f.lines.some((l) => l.includes("unknown agent() option 'bogusOpt'")));
  } finally { f.cleanup(); }
});

test('syntax error fails cleanly naming the script', async () => {
  const f = fixture();
  try {
    f.writeScript('const = = 3;');
    const res = await f.run();
    assert.equal(res.code, 1);
    assert.ok(f.lines.some((l) => l.includes('syntax error') && l.includes('w.mjs')));
  } finally { f.cleanup(); }
});

test('resume replays settled calls without respawning', async () => {
  const f = fixture();
  try {
    const scriptPath = f.writeScript(`const r = await parallel([0,1,2].map(i => () => agent('do '+i, {label:'a'+i})));
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    // Seed a journal as if call 0 settled in a prior run.
    const prior = Journal.create(f.dir, { runId: 'run-x', script: 'w.mjs', harness: 'echo' });
    prior.append({ type: 'agent', i: 0, label: 'a0', ok: true, result: { text: 'CACHED-0', json: null } });
    prior.append({ type: 'run-end', reason: 'interrupted' });

    calls.length = 0;
    const res = await runScript({ scriptPath, adapter: echo, cwd: f.dir, concurrency: 2, resumeId: 'run-x', err: (s) => f.lines.push(s) });
    assert.equal(res.code, 0);
    const r = f.lastResult();
    assert.equal(r[0], 'CACHED-0'); // replayed, not respawned
    assert.equal(calls.length, 2); // only i=1,2 executed
    assert.match(r[1], /echo\[a1\]/);
  } finally { f.cleanup(); }
});

test('resume with unknown run-id fails cleanly', async () => {
  const f = fixture();
  try {
    const scriptPath = f.writeScript('await agent("x");');
    const res = await runScript({ scriptPath, adapter: echo, cwd: f.dir, resumeId: 'nope', err: (s) => f.lines.push(s) });
    assert.equal(res.code, 1);
    assert.ok(f.lines.some((l) => l.includes("no journal for run 'nope'")));
  } finally { f.cleanup(); }
});

test('meta extraction: nested braces, braces in strings, unterminated fails clean', async () => {
  const f = fixture();
  try {
    f.writeScript(`export const meta = { name: 'n{a}b', nested: { deep: { x: 1 } }, list: [1,2] };
log('RESULT:' + JSON.stringify(meta));`);
    const res = await f.run();
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), { name: 'n{a}b', nested: { deep: { x: 1 } }, list: [1, 2] });
  } finally { f.cleanup(); }

  const g = fixture();
  try {
    g.writeScript('export const meta = { name: "x" ;\nawait agent("x");');
    const res = await g.run();
    assert.equal(res.code, 1);
    assert.ok(g.lines.some((l) => l.includes('meta')));
  } finally { g.cleanup(); }
});

test('missing binary returns null with error, not a crash', async () => {
  const fake = {
    name: 'fake', bin: 'agentflow-no-such-bin-xyz',
    requiredFlags: [], permissionDeniedPatterns: [],
    buildArgv: (s) => ['agentflow-no-such-bin-xyz', '-p', s.prompt],
    parse: (r) => ({ text: r.stdout, json: null }),
  };
  const r = await spawnAgent(fake, { prompt: 'hi', label: 't' });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /spawn failed|ENOENT/);
});

test('SIGINT: queued calls never start, settled journaled, run resumable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'af-sig-'));
  try {
    writeFileSync(join(dir, 'w.mjs'), `const r = await parallel([0,1,2,3,4,5].map(i => () => agent('do '+i, {label:'s'+i})));
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const bin = join(ROOT, 'bin/agentflow');
    const env = { ...process.env, AGENTFLOW_ECHO_SLOW: '500' };
    const child = spawn(process.execPath, [bin, 'run', 'w.mjs', '--harness', 'echo', '--concurrency', '2'], { cwd: dir, env });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    await new Promise((r) => setTimeout(r, 350)); // let 2 start, 4 still queued
    child.kill('SIGINT');
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 130);

    const runs = Journal.list(dir);
    assert.equal(runs.length, 1);
    const loaded = Journal.load(Journal.pathFor(dir, runs[0].runId));
    assert.equal(loaded.ended.reason, 'interrupted');
    const settledLabels = [...loaded.settled.values()].map((v) => v.label).sort();
    // At most the 2 in-flight slots may settle; queued calls must never start.
    assert.ok(settledLabels.length <= 2, `expected <=2 settled, got ${settledLabels}`);
    assert.ok(settledLabels.every((l) => l === 's0' || l === 's1'), `settled=${settledLabels}`);

    // Resume completes the remaining calls.
    const child2 = spawn(process.execPath, [bin, 'run', 'w.mjs', '--harness', 'echo', '--resume', runs[0].runId], { cwd: dir, env: { ...process.env } });
    let stderr2 = '';
    child2.stderr.on('data', (d) => { stderr2 += d; });
    const code2 = await new Promise((r) => child2.on('close', r));
    assert.equal(code2, 0);
    const resLine = stderr2.split('\n').find((l) => l.includes('RESULT:'));
    const results = JSON.parse(resLine.split('RESULT:')[1]);
    assert.equal(results.length, 6);
    assert.ok(results.every((x) => typeof x === 'string'));
    if (settledLabels.length) assert.match(stderr2, /replay s0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache: identical calls memoize across reruns without spawning', async () => {
  const f = fixture();
  try {
    f.writeScript(`const a = await agent('same prompt', {label:'a'});
const b = await agent('same prompt', {label:'b'});
log('R:' + a.text + '|' + b.text);`);
    await f.run({ cache: true });
    // Sequential identical calls: second is a cache hit — only 1 spawn, 1 cache file.
    assert.equal(calls.length, 1);
    assert.ok(f.lines.some((l) => l.includes('b -> cache')));

    // New run (new runId): both calls hit the content-keyed cache.
    const before = f.lines.length;
    await f.run({ cache: true });
    assert.equal(calls.length, 0);
    assert.equal(f.lines.slice(before).filter((l) => l.includes('-> cache')).length, 2);

    // Without --cache, the same script re-executes both calls.
    await f.run({ cache: false });
    assert.equal(calls.length, 2);
  } finally {
    f.cleanup();
  }
});

test('strict: nondeterministic script rejected before any agent runs', async () => {
  const f = fixture();
  try {
    f.writeScript(`const t = Date.now();
const r = Math.random();
await agent('x', {label:'a'});
log('never');`);
    const res = await f.run({ strict: true });
    assert.equal(res.code, 1);
    assert.equal(calls.length, 0); // rejected before spawn
    assert.ok(f.lines.some((l) => l.includes('line 1') && l.includes('Date.now')));
    assert.ok(f.lines.some((l) => l.includes('line 2') && l.includes('Math.random')));

    // Same script passes without --strict.
    calls.length = 0;
    const res2 = await f.run();
    assert.equal(res2.code, 0);
    assert.equal(calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test('strict: new Date() and crypto.randomUUID flagged; deterministic script passes', async () => {
  const f = fixture();
  try {
    f.writeScript(`const d = new Date('2020-01-01');
await agent('x', {label:'a'});`);
    const res = await f.run({ strict: true });
    assert.equal(res.code, 1);
    assert.ok(f.lines.some((l) => l.includes('new Date')));

    f.writeScript(`const stamped = 'new Date is fine as a string';
const fixed = await agent('x', {label:'b'});
log('done');`);
    const before = f.lines.length; // f.lines accumulates across runs
    const res2 = await f.run({ strict: true });
    assert.equal(res2.code, 0);
    assert.ok(!f.lines.slice(before).some((l) => l.includes('nondeterministic')));
  } finally {
    f.cleanup();
  }
});

test('maxAgents: cap aborts the run with a clear error', async () => {
  const f = fixture();
  try {
    f.writeScript(`await parallel([1,2,3,4,5].map(n => () => agent('p'+n, {label:'a'+n})));
log('never');`);
    const res = await f.run({ maxAgents: 3 });
    assert.equal(res.code, 1);
    assert.ok(f.lines.some((l) => l.includes('cap exceeded')));
    assert.ok(calls.length <= 3);
    // Default 1000 unaffected by small runs
    const res2 = await f.run();
    assert.equal(res2.code, 0);
    assert.equal(calls.length, 5);
  } finally {
    f.cleanup();
  }
});

test('retries: transient flake recovers within cap; per-call and run defaults', async () => {
  const f = fixture();
  try {
    process.env.AGENTFLOW_ECHO_FLAKY = 'flaky';
    f.writeScript(`const a = await agent('x', {label:'flaky-a'});
const b = await agent('y', {label:'solid-b'});
log('RESULT:' + JSON.stringify({R: (a?.text ? 'ok' : 'null') + '|' + (b?.text ? 'ok' : 'null')}));`);
    // Run-level retries=1: flaky-a fails once, retries, succeeds.
    const res = await f.run({ retries: 1 });
    assert.equal(res.code, 0);
    assert.ok(f.lines.some((l) => l.includes('flaky-a retry 1/1')));
    assert.equal(f.lastResult().R, 'ok|ok');
    assert.equal(calls.length, 3); // flaky×2 + solid×1

    // No retries (default): flaky is now spent; use permanent FAIL for the null path.
    delete process.env.AGENTFLOW_ECHO_FLAKY;
    process.env.AGENTFLOW_ECHO_FAIL = 'doomed';
    f.writeScript(`const a = await agent('x', {label:'doomed-a'});
log('done');`);
    calls.length = 0;
    await f.run();
    assert.equal(calls.length, 1); // no retry

    // Permanent failure WITH retries=2: 3 attempts, still null.
    calls.length = 0;
    await f.run({ retries: 2 });
    assert.equal(calls.length, 3);

    // Per-call override beats run default: retries:0 inside agent() with run retries=5.
    calls.length = 0;
    f.writeScript(`await agent('x', {label:'doomed-b', retries:0});`);
    await f.run({ retries: 5 });
    assert.equal(calls.length, 1);
  } finally {
    delete process.env.AGENTFLOW_ECHO_FLAKY;
    delete process.env.AGENTFLOW_ECHO_FAIL;
    f.cleanup();
  }
});

test('retries: permissionDenied and timeout are never retried', async () => {
  const f = fixture();
  try {
    process.env.AGENTFLOW_ECHO_DENY = 'denied';
    f.writeScript(`await agent('x', {label:'denied-a'});`);
    await f.run({ retries: 3 });
    assert.equal(calls.length, 1);
    delete process.env.AGENTFLOW_ECHO_DENY;

    process.env.AGENTFLOW_ECHO_SLOW = '5000';
    f.writeScript(`await agent('x', {label:'slow-a', timeout:50});`);
    calls.length = 0;
    await f.run({ retries: 3 });
    assert.equal(calls.length, 1);
  } finally {
    delete process.env.AGENTFLOW_ECHO_DENY;
    delete process.env.AGENTFLOW_ECHO_SLOW;
    f.cleanup();
  }
});
