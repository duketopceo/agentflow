import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJournal, foldState, renderFrame, bigNumber } from '../src/watch.mjs';
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

test('foldState: a resumed epoch does not retain an earlier terminal state', () => {
  const s = foldState(recs([
    { type: 'run-start', runId: 'r1', at: '2026-10-11T00:00:00Z' },
    { type: 'agent', i: 0, label: 'old', ok: true, result: { text: 'x' } },
    { type: 'run-end', reason: 'ok' },
    { type: 'run-start', runId: 'r1', at: '2026-10-11T00:01:00Z' },
    { type: 'in-flight', i: 1, label: 'new', at: '2026-10-11T00:01:01Z' },
  ]));
  assert.equal(s.done, null);
  assert.equal(s.lanes.size, 1);
  assert.equal(s.lanes.get(1).state, 'in-flight');
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
  assert.match(f, /w\.mjs · echo · m1/); // title: script + harness + models, no run-id
  assert.match(f, /· 1:00 ·/);
  assert.match(f, /pid 42/);
  assert.match(f, /█+░+ 1 of ~2 steps/);
  assert.match(f, /✓ \[0\] a \(m1\)\s+ok 1\.0s/);
  assert.match(f, /◐ \[1\] b\s+running 58s/);
  assert.match(f, /▶ batch\[2\] b-1\s+in_progress  1\/2 settled/);
  assert.match(f, /ok 1 fail 0 running 1 · run r1/);
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
    j.append({ type: 'phase', name: 'old-epoch', nextI: 0, at: '2026-01-01T00:00:00Z' });
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
    j.append({ type: 'phase', name: 'scout', nextI: 0, at: '2026-01-01T00:00:00Z' });
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
    assert.match(o2, /▶ phase: scout/);
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

test('renderFrame: per-lane + footer token totals from usage records', () => {
  const s = foldState(recs([
    { type: 'run-start', runId: 'r1', script: 'w.mjs', harness: 'devin', at: '2026-10-11T00:00:00.000Z' },
    { type: 'agent', i: 0, label: 'a', ok: true, result: { text: 'x', usage: { promptTokens: 1000, completionTokens: 50 } }, elapsed: '1.0', at: '2026-10-11T00:00:03.000Z' },
    { type: 'agent', i: 1, label: 'b', ok: false, error: { message: 'boom', usage: { promptTokens: 500, completionTokens: 10 } }, elapsed: '0.5', at: '2026-10-11T00:00:04.000Z' },
    { type: 'run-end', reason: 'ok', at: '2026-10-11T00:00:05.000Z' },
  ]));
  const f = renderFrame(s, { now: Date.parse('2026-10-11T00:01:00.000Z'), width: 90, tick: 0 });
  assert.match(f, /ok 1\.0s 1\.0k\/50/);
  assert.match(f, /fail 0\.5s 500\/10/);
  assert.match(f, /tokens 1\.5k\/60/);
  assert.match(f, /run r1/); // run-id demoted to footer
});

test('foldState: phase records stamp lanes; agent records keep the in-flight stamp', () => {
  const s = foldState(recs([
    { type: 'run-start', runId: 'r1', at: '2026-10-11T00:00:00Z' },
    { type: 'phase', name: 'collect', nextI: 0, at: '2026-10-11T00:00:01Z' },
    { type: 'in-flight', i: 0, label: 'a', at: '2026-10-11T00:00:02Z' },
    { type: 'phase', name: 'synthesize', nextI: 1, at: '2026-10-11T00:00:10Z' },
    { type: 'agent', i: 0, label: 'a', ok: true, result: { text: 'x' }, at: '2026-10-11T00:00:11Z' },
    { type: 'in-flight', i: 1, label: 'b', at: '2026-10-11T00:00:12Z' },
  ]));
  assert.deepEqual(s.phases.map((p) => p.name), ['collect', 'synthesize']);
  assert.equal(s.lanes.get(0).phase, 'collect'); // settled during 'synthesize', started in 'collect'
  assert.equal(s.lanes.get(1).phase, 'synthesize');
});

test('renderFrame: lanes group under phases; declared-only phases render as upcoming', () => {
  const s = foldState(recs([
    { type: 'run-start', runId: 'r1', script: 'w.mjs', name: 'Audit', harness: 'echo', phases: ['collect', 'synthesize', 'report'], at: '2026-10-11T00:00:00.000Z', pid: 42 },
    { type: 'phase', name: 'collect', nextI: 0, at: '2026-10-11T00:00:01.000Z' },
    { type: 'in-flight', i: 0, label: 'rev:a', at: '2026-10-11T00:00:02.000Z' },
    { type: 'agent', i: 0, label: 'rev:a', ok: true, result: { text: 'Found 3 issues in billing.' }, elapsed: '1.0', at: '2026-10-11T00:00:09.000Z' },
    { type: 'phase', name: 'synthesize', nextI: 1, at: '2026-10-11T00:00:10.000Z' },
    { type: 'in-flight', i: 1, label: 'synth', at: '2026-10-11T00:00:11.000Z' },
  ]));
  const f = renderFrame(s, { now: Date.parse('2026-10-11T00:01:00.000Z'), width: 90, tick: 0 });
  const at = (re) => f.split('\n').findIndex((l) => re.test(l));
  assert.match(f, /Audit · echo/); // meta.name titles the frame
  const hCollect = at(/✓ collect — 1\/1/);
  const hSynth = at(/▶ synthesize — 0\/1/);
  const hReport = at(/◇ report — upcoming/);
  const lane0 = at(/\[0\] rev:a/);
  const lane1 = at(/\[1\] synth/);
  const found = at(/Found 3 issues in billing\./);
  assert.ok(hCollect !== -1 && hCollect < lane0, 'phase header precedes its lanes');
  assert.ok(lane0 < found && found < hSynth, 'result one-liner under the ok lane');
  assert.ok(hSynth < lane1 && lane1 < hReport, 'pending phase after the active group');
});

test('renderFrame: un-phased lanes sort into their real position between phases', () => {
  const s = foldState(recs([
    { type: 'run-start', runId: 'r1', at: '2026-10-11T00:00:00Z' },
    { type: 'in-flight', i: 0, label: 'early', at: '2026-10-11T00:00:01Z' }, // before any phase()
    { type: 'agent', i: 0, label: 'early', ok: true, result: { text: 'x' }, at: '2026-10-11T00:00:02Z' },
    { type: 'phase', name: 'work', nextI: 1, at: '2026-10-11T00:00:03Z' },
    { type: 'in-flight', i: 1, label: 'w1', at: '2026-10-11T00:00:04Z' },
  ]));
  const f = renderFrame(s, { width: 80 });
  const at = (re) => f.split('\n').findIndex((l) => re.test(l));
  assert.ok(at(/\[0\] early/) < at(/work —/), 'pre-phase lane renders before the first phase header');
});

test('renderFrame: journals without phase records fold to one flat group', () => {
  const s = foldState(recs([
    { type: 'run-start', runId: 'r1', script: 'old.mjs', at: '2026-10-11T00:00:00Z' },
    { type: 'in-flight', i: 0, label: 'a', at: '2026-10-11T00:00:01Z' },
    { type: 'agent', i: 0, label: 'a', ok: true, result: { text: 'done' }, elapsed: '1.0', at: '2026-10-11T00:00:05Z' },
  ]));
  assert.equal(s.phases.length, 0);
  assert.equal(s.lanes.get(0).phase, null);
  const f = renderFrame(s, { width: 80 });
  assert.match(f, /\[0\] a\s+ok 1\.0s/);
  assert.doesNotMatch(f, /upcoming|— \d+\/\d+/); // no group headers
});

test('renderFrame: result one-liner takes the first line, truncates ~90', () => {
  const long = 'A'.repeat(50) + '. This trailing sentence must be dropped.';
  const s = foldState(recs([
    { type: 'agent', i: 0, label: 'a', ok: true, result: { text: `${long}\nSecond line never rendered.` }, elapsed: '1.0' },
    { type: 'agent', i: 1, label: 'b', ok: true, result: { text: 'x'.repeat(200) }, elapsed: '2.0' },
  ]));
  assert.equal(s.lanes.get(0).summary, 'A'.repeat(50) + '.');
  const f = renderFrame(s, { width: 100 });
  assert.match(f, new RegExp(`^ {4}${'A'.repeat(50)}\\.$`, 'm'));
  assert.doesNotMatch(f, /trailing sentence|Second line/);
  assert.match(f, /^ {4}x{89}…$/m); // long single line ellipsized to ~90
});

test('journal: phase() writes a journaled record; load() collects phases', async () => {
  const d = dir();
  try {
    const scriptPath = join(d, 'w.mjs');
    writeFileSync(scriptPath, `phase('gather'); await agent('a'); phase('wrap');`);
    const res = await runScript({ scriptPath, adapter: echo, cwd: d, err: () => {} });
    assert.equal(res.code, 0);
    const records = readJournal(Journal.pathFor(d, res.runId));
    const phases = records.filter((r) => r.type === 'phase');
    assert.deepEqual(phases.map((p) => p.name), ['gather', 'wrap']);
    assert.deepEqual(phases.map((p) => p.nextI), [0, 1]);
    const meta = Journal.load(Journal.pathFor(d, res.runId));
    assert.equal(meta.phases.length, 2);
    assert.equal(meta.settled.size, 1); // replay surface unchanged
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('bigNumber renders block digits; done frame ends with spend card', () => {
  const b = bigNumber('37k');
  assert.equal(b.split('\n').length, 5);
  assert.match(b.split('\n')[0], /█████ █████ █   █/);

  const s = foldState(recs([
    { type: 'run-start', runId: 'r1', at: '2026-10-11T00:00:00.000Z' },
    { type: 'agent', i: 0, ok: true, result: { text: 'x', usage: { promptTokens: 36500, completionTokens: 500 } }, elapsed: '1.0', at: 't' },
    { type: 'run-end', reason: 'ok', at: 't' },
  ]));
  const f = renderFrame(s, { width: 90, tick: 0 });
  assert.match(f, /total tokens \(in\+out\)/);
  assert.match(f, /█████ █████ █   █/); // 37k in block font

  const usd = foldState(recs([
    { type: 'agent', i: 0, ok: true, result: { text: 'x', usage: { costUsd: 0.04 } }, at: 't' },
    { type: 'run-end', reason: 'ok', at: 't' },
  ]));
  const f2 = renderFrame(usd, { width: 90 });
  assert.match(f2, /total spend/);
  assert.match(f2.split('\n').find((l) => l.includes('█')), /██/);

  const free = foldState(recs([
    { type: 'agent', i: 0, ok: true, result: { text: 'x', usage: { costUsd: 0 } }, at: 't' },
    { type: 'run-end', reason: 'ok', at: 't' },
  ]));
  const f3 = renderFrame(free, { width: 90 });
  // "$0.00" renders as block glyphs, not literal text — assert the card
  // chosen is the dollar one, not the token fallback.
  assert.match(f3, /total spend/, 'a reported $0 spend still gets the dollar card');
  assert.doesNotMatch(f3, /total tokens/);
});
