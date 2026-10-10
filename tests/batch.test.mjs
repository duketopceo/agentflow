import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runScript } from '../src/runtime.mjs';
import { Journal } from '../src/journal.mjs';
import openrouter from '../src/adapters/openrouter.mjs';
import echo from '../src/adapters/echo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'af-batch-'));
  const scriptPath = join(dir, 'w.mjs');
  const lines = [];
  return {
    dir, lines,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    writeScript(src) { writeFileSync(scriptPath, src); return scriptPath; },
    async run(extra = {}) {
      return runScript({
        scriptPath, adapter: openrouter, cwd: dir, concurrency: 2,
        sleep: () => Promise.resolve(),
        err: (s) => lines.push(s), ...extra,
      });
    },
    lastResult() {
      const line = lines.findLast((l) => l.includes('RESULT:'));
      return line ? JSON.parse(line.split('RESULT:')[1]) : undefined;
    },
  };
}

// Canned-response fetch: each call shifts one {status, data} off queue.
function stubFetch(queue) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const next = queue.length ? queue.shift() : { status: 500, data: { error: { message: 'unstubbed call' } } };
    return { ok: next.status < 300, status: next.status, json: async () => next.data };
  };
  return { calls, fetchImpl };
}

const completedBody = (texts) => ({
  status: 'completed',
  results: texts.map((t, i) => ({ custom_id: `c${i}`, result: { choices: [{ message: { content: t } }] } })),
});

function withKey(fn) {
  return async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    try { await fn(); } finally { delete process.env.OPENROUTER_API_KEY; }
  };
}

test('batch: one submit, aligned results, per-item agent records', withKey(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([
      { status: 202, data: { id: 'b1', status: 'validating' } },
      { status: 200, data: { status: 'in_progress' } },
      { status: 200, data: completedBody(['A', 'B']) },
    ]);
    f.writeScript(`const r = await batch([{prompt:'p0',label:'x0'},{prompt:'p1',label:'x1'}], {model:'m/b'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const res = await f.run({ fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', 'B']);
    assert.equal(stub.calls.filter((c) => c.method === 'POST').length, 1); // exactly one submit
    assert.equal(stub.calls[0].body.model, 'm/b');

    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.equal(loaded.batches.length, 1);
    assert.equal(loaded.batches[0].batch_id, 'b1');
    assert.equal(loaded.batches[0].firstI, 0);
    assert.equal(loaded.batches[0].count, 2);
    assert.equal(loaded.settled.get(0).result.text, 'A');
    assert.equal(loaded.settled.get(1).result.text, 'B');
  } finally { f.cleanup(); }
}));

test('batch: resume re-polls journaled batch_id — never resubmits', withKey(async () => {
  const f = fixture();
  try {
    const scriptPath = f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'m/b'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    // Seed a pending batch record whose hash matches the script's requests.
    const bodies = [{ prompt: 'p0' }, { prompt: 'p1' }].map((s) => openrouter.batchBody({ ...s, model: 'm/b' }));
    const hash = createHash('sha256').update(JSON.stringify({ model: 'm/b', bodies })).digest('hex').slice(0, 16);
    const prior = Journal.create(f.dir, { runId: 'run-b', script: 'w.mjs', harness: 'openrouter' });
    prior.append({ type: 'batch', batch_id: 'b-old', firstI: 0, count: 2, model: 'm/b', hash });
    prior.append({ type: 'run-end', reason: 'interrupted' });

    const stub = stubFetch([{ status: 200, data: completedBody(['A', 'B']) }]);
    const res = await f.run({ resumeId: 'run-b', fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', 'B']);
    assert.equal(stub.calls.filter((c) => c.method === 'POST').length, 0); // re-polled only
    assert.ok(f.lines.some((l) => l.includes('re-polling journaled batch b-old')));
  } finally { f.cleanup(); }
}));

test('batch: hash mismatch on resume submits a fresh batch', withKey(async () => {
  const f = fixture();
  try {
    f.writeScript(`const r = await batch([{prompt:'different'}], {model:'m/b'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const prior = Journal.create(f.dir, { runId: 'run-b2', script: 'w.mjs', harness: 'openrouter' });
    prior.append({ type: 'batch', batch_id: 'b-stale', firstI: 0, count: 1, model: 'm/b', hash: 'wronghash' });
    prior.append({ type: 'run-end', reason: 'interrupted' });

    const stub = stubFetch([
      { status: 202, data: { id: 'b-new', status: 'validating' } },
      { status: 200, data: completedBody(['Z']) },
    ]);
    const res = await f.run({ resumeId: 'run-b2', fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['Z']);
    assert.equal(stub.calls.filter((c) => c.method === 'POST').length, 1);
    assert.match(stub.calls.at(-1).url, /b-new$/);
    assert.ok(f.lines.some((l) => l.includes('submitting fresh')));
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.equal(loaded.batches.at(-1).batch_id, 'b-new');
  } finally { f.cleanup(); }
}));

test('batch: fully settled indices replay with zero requests', withKey(async () => {
  const f = fixture();
  try {
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'m/b'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const prior = Journal.create(f.dir, { runId: 'run-b3', script: 'w.mjs', harness: 'openrouter' });
    prior.append({ type: 'batch', batch_id: 'b-done', firstI: 0, count: 2, model: 'm/b', hash: 'any' });
    prior.append({ type: 'agent', i: 0, label: 'batch-0', ok: true, result: { text: 'A', json: null } });
    prior.append({ type: 'agent', i: 1, label: 'batch-1', ok: false, error: { message: 'boom' } });
    prior.append({ type: 'run-end', reason: 'interrupted' });

    const stub = stubFetch([]);
    const res = await f.run({ resumeId: 'run-b3', fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', null]);
    assert.equal(stub.calls.length, 0);
  } finally { f.cleanup(); }
}));

test('batch: terminal failed/expired settles every item null with the reason', withKey(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([
      { status: 202, data: { id: 'b-f', status: 'validating' } },
      { status: 200, data: { status: 'failed', error: { message: 'provider down' } } },
    ]);
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'},{prompt:'p2'}], {model:'m/b'});
log('RESULT:' + JSON.stringify(r));`);
    const res = await f.run({ fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), [null, null, null]);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.equal(loaded.settled.get(0).ok, false);
    assert.match(loaded.settled.get(0).error.message, /provider down/);
  } finally { f.cleanup(); }
}));

test('batch: per-request error inside completed settles only that index null', withKey(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([
      { status: 202, data: { id: 'b-p', status: 'validating' } },
      {
        status: 200, data: {
          status: 'completed',
          results: [
            { custom_id: 'c0', result: { choices: [{ message: { content: 'A' } }] } },
            { custom_id: 'c1', result: { error: { message: 'content policy' } } },
            { custom_id: 'c2', result: { choices: [{ message: { content: 'C' } }] } },
          ],
        },
      },
    ]);
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'},{prompt:'p2'}], {model:'m/b'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const res = await f.run({ fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', null, 'C']);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.match(loaded.settled.get(1).error.message, /content policy/);
  } finally { f.cleanup(); }
}));

test('batch: mixed per-item models fails before any request', withKey(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([]);
    f.writeScript(`await batch([{prompt:'a',model:'m/1'},{prompt:'b',model:'m/2'}]);`);
    const res = await f.run({ fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 1);
    assert.ok(f.lines.some((l) => l.includes('single-model') && l.includes('m/1') && l.includes('m/2')));
    assert.equal(stub.calls.length, 0);
  } finally { f.cleanup(); }
}));

test('batch: non-batch adapter aborts the run before submitting', async () => {
  const f = fixture();
  try {
    f.writeScript(`await batch([{prompt:'a'}]);`);
    const res = await runScript({ scriptPath: join(f.dir, 'w.mjs'), adapter: echo, cwd: f.dir, err: (s) => f.lines.push(s) });
    assert.equal(res.code, 1);
    assert.ok(f.lines.some((l) => l.includes('batch-capable harness') && l.includes('echo')));
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.equal(loaded.ended.reason, 'error');
    assert.equal(loaded.settled.size, 0);
  } finally { f.cleanup(); }
});

test('batch: empty array resolves to [] without a request', withKey(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([]);
    f.writeScript(`const r = await batch([]);
log('RESULT:' + JSON.stringify(r));`);
    const res = await f.run({ fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), []);
    assert.equal(stub.calls.length, 0);
  } finally { f.cleanup(); }
}));

test('batch: SIGINT mid-poll leaves a pending record; resume re-polls without resubmitting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-batch-sig-'));
  let server;
  try {
    writeFileSync(join(dir, 'w.mjs'), `const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'m/b', batchPollMs: 50});
log('RESULT:' + JSON.stringify(r && r.map(x => x && x.text)));`);
    let complete = false;
    let posts = 0;
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST') {
          posts++;
          res.end(JSON.stringify({ id: 'b-live', status: 'validating' }));
        } else {
          res.end(JSON.stringify(complete ? completedBody(['A', 'B']) : { status: 'in_progress' }));
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const env = {
      ...process.env,
      OPENROUTER_API_KEY: 'k',
      AGENTFLOW_OPENROUTER_BASE: `http://127.0.0.1:${server.address().port}`,
    };
    const bin = join(ROOT, 'bin/agentflow');
    const child = spawn(process.execPath, [bin, 'run', 'w.mjs', '--harness', 'openrouter', '--grace', '1500'], { cwd: dir, env });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    await new Promise((r) => setTimeout(r, 800)); // submit + a few polls
    child.kill('SIGINT');
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 130);

    const runs = Journal.list(dir);
    assert.equal(runs.length, 1);
    const loaded = Journal.load(Journal.pathFor(dir, runs[0].runId));
    assert.equal(loaded.ended.reason, 'interrupted');
    assert.equal(loaded.batches.length, 1);
    assert.equal(loaded.batches[0].batch_id, 'b-live');
    assert.equal(loaded.settled.size, 0); // nothing settled mid-poll
    assert.equal(posts, 1);

    complete = true;
    const child2 = spawn(process.execPath, [bin, 'run', 'w.mjs', '--harness', 'openrouter', '--resume', runs[0].runId], { cwd: dir, env });
    let stderr2 = '';
    child2.stderr.on('data', (d) => { stderr2 += d; });
    const code2 = await new Promise((r) => child2.on('close', r));
    assert.equal(code2, 0);
    assert.equal(posts, 1); // re-polled the same batch — never resubmitted
    assert.match(stderr2, /re-polling journaled batch b-live/);
    const resLine = stderr2.split('\n').find((l) => l.includes('RESULT:'));
    assert.deepEqual(JSON.parse(resLine.split('RESULT:')[1]), ['A', 'B']);
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
