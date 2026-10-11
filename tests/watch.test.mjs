import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJournal, foldState, renderFrame } from '../src/watch.mjs';
import { Journal } from '../src/journal.mjs';
import { runScript } from '../src/runtime.mjs';
import echo from '../src/adapters/echo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin', 'agentflow');

function dir() { return mkdtempSync(join(tmpdir(), 'af-watch-')); }

const recs = (arr) => arr;

test('foldState: in-flight -> ok/fail transitions per index', () => {
  const s = foldState(recs([
    { type: 'run-start', runId: 'r1', script: 'w.mjs', harness: 'echo', at: '2026-10-11T00:00:00Z', pid: 1 },
    { type: 'in-flight', i: 0, label: 'a', model: 'm1', at: '2026-10-11T00:00:01Z' },
    { type: 'in-flight', i: 1, label: 'b', at: '2026-10-11T00:00:02Z' },
    { type: 'agent', i: 0, label: 'a', ok: true, result: { text: 'x' }, elapsed: '1.0', at: '2026-10-11T00:00:03Z' },
  ]));
  assert.equal(s.lanes.get(0).state, 'ok');
  assert.equal(s.lanes.get(1).state, 'in-flight');
  assert.equal(s.done, null);
});

test('foldState: batch records + latest poll; run-end abandons open lanes', () => {
  const s = foldState(recs([
    { type: 'run-start', runId: 'r1', at: '2026-10-11T00:00:00Z' },
    { type: 'batch', batch_id: 'b-1', firstI: 0, count: 2, model: 'm' },
    { type: 'in-flight', i: 0, label: 'batch-0', batch: 'b-1', at: '2026-10-11T00:00:01Z' },
    { type: 'in-flight', i: 1, label: 'batch-1', batch: 'b-1', at: '2026-10-11T00:00:01Z' },
    { type: 'batch-poll', batch_id: 'b-1', status: 'in_progress', settled: 0, total: 2, at: '2026-10-11T00:00:05Z' },
    { type: 'batch-poll', batch_id: 'b-1', status: 'in_progress', settled: 1, total: 2, at: '2026-10-11T00:00:20Z' },
    { type: 'run-end', reason: 'interrupted', at: '2026-10-11T00:00:30Z' },
  ]));
  const b = s.batches.get('b-1');
  assert.equal(b.status, 'in_progress');
  assert.equal(b.poll.settled, 1); // latest poll wins
  assert.equal(s.lanes.get(0).state, 'abandoned');
  assert.equal(s.done.reason, 'interrupted');
});

test('renderFrame: deterministic layout for a fixed state + now + tick', () => {
  const s = foldState(recs([
    { type: 'run-start', runId: 'r1', script: 'w.mjs', harness: 'echo', at: '2026-10-11T00:00:00.000Z', pid: 42 },
    { type: 'in-flight', i: 0, label: 'a', model: 'm1', at: '2026-10-11T00:00:01.000Z' },
    { type: 'agent', i: 0, label: 'a', ok: true, result: { text: 'x' }, model: 'm1', elapsed: '1.0', at: '2026-10-11T00:00:03.000Z' },
    { type: 'in-flight', i: 1, label: 'b', at: '2026-10-11T00:00:02.000Z' },
    { type: 'batch', batch_id: 'b-1', firstI: 2, count: 2, model: 'm' },
    { type: 'batch-poll', batch_id: 'b-1', status: 'in_progress', settled: 1, total: 2, at: '2026-10-11T00:00:20.000Z' },
  ]));
  const now = Date.parse('2026-10-11T00:01:00.000Z');
  const f = renderFrame(s, { now, width: 80, tick: 0, pidAlive: true });
  assert.match(f, /agentflow watch — r1/);
  assert.match(f, /harness=echo/);
  assert.match(f, /elapsed 1:00/);
  assert.match(f, /pid 42/);
  assert.match(f, /● \[0\] a \(m1\)\s+ok 1\.0s/);
  assert.match(f, /◐ \[1\] b\s+in-flight 58s/);
  assert.match(f, /▶ batch\[2\] b-1\s+in_progress  1\/2 settled/);
  assert.match(f, /settled 1  ok 1  failed 0  in-flight 1/);
  assert.ok(f.split('\n').every((l) => l.length <= 80));
});

test('renderFrame: final frame shows run-end reason; narrow widths truncate', () => {
  const s = foldState(recs([
    { type: 'run-start', runId: 'r9', script: 'a-very-long-script-name.mjs', at: '2026-10-11T00:00:00Z' },
    { type: 'in-flight', i: 0, label: 'x', at: '2026-10-11T00:00:00Z' },
    { type: 'run-end', reason: 'ok', at: '2026-10-11T00:00:05Z' },
  ]));
  const f = renderFrame(s, { now: Date.parse('2026-10-11T00:00:06Z'), width: 40, tick: 1 });
  assert.match(f, /run ok/);
  assert.match(f, /abandoned 1/);
  assert.ok(f.split('\n').every((l) => l.length <= 40));
});

test('journal: in-flight precedes agent for the same index; load() folds open items', async () => {
  const d = dir();
  try {
    const scriptPath = join(d, 'w.mjs');
    writeFileSync(scriptPath, `const r = await agent('a'); log('RESULT:' + (r && r.text));`);
    const res = await runScript({ scriptPath, adapter: echo, cwd: d, err: () => {} });
    assert.equal(res.code, 0);
    const records = readJournal(Journal.pathFor(d, res.runId));
    const types = records.map((r) => r.type);
    const fi = types.indexOf('in-flight'), ai = types.indexOf('agent');
    assert.ok(fi !== -1 && ai !== -1 && fi < ai, `expected in-flight before agent, got ${types}`);
    const meta = Journal.load(Journal.pathFor(d, res.runId));
    assert.equal(meta.inFlight.size, 0); // settled lane is not "in-flight"
    assert.equal(meta.settled.size, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('journal: batch emits per-item in-flight + batch-poll records', async () => {
  const d = dir();
  try {
    const scriptPath = join(d, 'w.mjs');
    writeFileSync(scriptPath, `await batch([{prompt:'p0'},{prompt:'p1'}], {model:'m'});`);
    const calls = [
      { status: 202, data: { id: 'b-1', status: 'validating' } },
      { status: 200, data: { status: 'completed', results: [{ custom_id: 'c0', result: { choices: [{ message: { content: 'A' } }] } }, { custom_id: 'c1', result: { choices: [{ message: { content: 'B' } }] } }] } },
    ];
    const fetchImpl = async () => { const n = calls.shift() ?? { status: 500, data: {} }; return { ok: n.status < 300, status: n.status, json: async () => n.data }; };
    process.env.OPENROUTER_API_KEY = 'test-key';
    let res;
    try {
      res = await runScript({ scriptPath, adapter: (await import('../src/adapters/openrouter.mjs')).default, cwd: d, sleep: () => Promise.resolve(), fetchImpl, err: () => {} });
    } finally { delete process.env.OPENROUTER_API_KEY; }
    assert.equal(res.code, 0);
    const types = readJournal(Journal.pathFor(d, res.runId)).map((r) => r.type);
    assert.equal(types.filter((t) => t === 'in-flight').length, 2);
    assert.ok(types.includes('batch-poll'));
    const meta = Journal.load(Journal.pathFor(d, res.runId));
    assert.equal(meta.inFlight.size, 0);
    assert.equal(meta.batchPolls.length, 1);
    assert.equal(meta.batchPolls[0].status, 'completed');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resume ignores progress records: replay unaffected', async () => {
  const d = dir();
  try {
    const scriptPath = join(d, 'w.mjs');
    writeFileSync(scriptPath, `const r = await agent('a'); log('RESULT:' + (r && r.text));`);
    const j = Journal.create(d, { runId: 'run-r', script: 'w.mjs', harness: 'echo' });
    j.append({ type: 'in-flight', i: 0, label: 'a', at: '2026-01-01T00:00:00Z' });
    j.append({ type: 'batch-poll', batch_id: 'b-x', status: 'in_progress', at: '2026-01-01T00:00:01Z' });
    j.append({ type: 'agent', i: 0, label: 'a', ok: true, result: { text: 'CACHED' }, at: '2026-01-01T00:00:02Z' });
    j.append({ type: 'run-end', reason: 'interrupted' });
    const lines = [];
    const res = await runScript({ scriptPath, adapter: echo, cwd: d, resumeId: 'run-r', err: (s) => lines.push(s) });
    assert.equal(res.code, 0);
    assert.ok(lines.some((l) => l.includes('RESULT:') && l.includes('CACHED')), JSON.stringify(lines));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('watch CLI: missing journal exits 2; non-TTY behaves like tail', async () => {
  const d = dir();
  try {
    const r1 = spawn('node', [BIN, 'watch', 'no-such-run'], { cwd: d });
    const [c1, , e1] = await new Promise((res) => {
      let o = '', e = '';
      r1.stdout.on('data', (d) => (o += d));
      r1.stderr.on('data', (d) => (e += d));
      r1.on('exit', (c) => res([c, o, e]));
    });
    assert.equal(c1, 2);
    assert.match(e1, /no journal/);

    // Non-TTY: finished journal -> streams events like tail, exits 0.
    const j = Journal.create(d, { runId: 'run-f', script: 'w.mjs', harness: 'echo' });
    j.append({ type: 'agent', i: 0, label: 'a', ok: true, result: { text: 'x' }, at: '2026-01-01T00:00:01Z' });
    j.append({ type: 'run-end', reason: 'ok', at: '2026-01-01T00:00:02Z' });
    const r2 = spawn('node', [BIN, 'watch', 'run-f'], { cwd: d });
    const [c2, o2] = await new Promise((res) => {
      let o = '';
      r2.stdout.on('data', (d) => (o += d));
      r2.stderr.on('data', () => {});
      r2.on('exit', (c) => res([c, o]));
    });
    assert.equal(c2, 0);
    assert.match(o2, /run started/);
    assert.match(o2, /\[0\] a -> ok/);
    assert.match(o2, /run ended: ok/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('watch CLI: no arg resolves the newest journal in cwd', async () => {
  const d = dir();
  try {
    const j = Journal.create(d, { runId: 'run-z', script: 'w.mjs', harness: 'echo' });
    j.append({ type: 'agent', i: 0, label: 'a', ok: true, result: { text: 'x' }, at: '2026-01-01T00:00:01Z' });
    j.append({ type: 'run-end', reason: 'ok', at: '2026-01-01T00:00:02Z' });
    const child = spawn('node', [BIN, 'watch'], { cwd: d });
    const [code, out] = await new Promise((res) => {
      let o = '';
      child.stdout.on('data', (d) => (o += d));
      child.on('exit', (c) => res([c, o]));
    });
    assert.equal(code, 0);
    assert.match(out, /run started w\.mjs/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
