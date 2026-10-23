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
import devin from '../src/adapters/devin.mjs';
import perplexity from '../src/adapters/perplexity.mjs';
import openai from '../src/adapters/openai.mjs';
import anthropic from '../src/adapters/anthropic.mjs';
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
    let body = opts.body ?? null;
    if (body instanceof FormData) {
      body = { __formData: true, purpose: opts.body.get('purpose') }; // openai file upload
    } else if (typeof body === 'string') body = JSON.parse(body);
    calls.push({ url, method: opts.method ?? 'GET', body, headers: opts.headers ?? {} });
    const next = queue.length ? queue.shift() : { status: 500, data: { error: { message: 'unstubbed call' } } };
    return { ok: next.status < 300, status: next.status, json: async () => next.data, text: async () => next.text ?? JSON.stringify(next.data) };
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

test('batch: a changed item resubmits alone — unchanged items replay', withKey(async () => {
  const f = fixture();
  try {
    // Real first run: 3 items complete, journal carries real fingerprints.
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'},{prompt:'p2'}], {model:'m/b'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const stub1 = stubFetch([
      { status: 202, data: { id: 'b-1', status: 'validating' } },
      { status: 200, data: completedBody(['A', 'B', 'C']) },
    ]);
    const r1 = await f.run({ fetchImpl: stub1.fetchImpl });
    assert.equal(r1.code, 0);
    assert.deepEqual(f.lastResult(), ['A', 'B', 'C']);

    // Edit ONLY item 1's prompt — resume must replay 0+2, resubmit just item 1.
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'EDITED'},{prompt:'p2'}], {model:'m/b'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const stub2 = stubFetch([
      { status: 202, data: { id: 'b-2', status: 'validating' } },
      { status: 200, data: completedBody(['Z']) },
    ]);
    const res = await f.run({ resumeId: r1.runId, fetchImpl: stub2.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', 'Z', 'C']);
    // Exactly one submission, covering one body.
    const posts = stub2.calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.requests.length, 1);
    // The fresh batch record names its exact item coverage (non-contiguous safe).
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.deepEqual(loaded.batches.at(-1).items, [1]);
    assert.ok(f.lines.some((l) => l.includes('2 unchanged (replayed), 1 to submit')));
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

// --- devin (cloud sessions) ------------------------------------------------

function withDevinAuth(fn) {
  return async () => {
    process.env.DEVIN_API_KEY = 'test-devin-key';
    process.env.DEVIN_ORG_ID = 'org-test';
    try { await fn(); } finally { delete process.env.DEVIN_API_KEY; delete process.env.DEVIN_ORG_ID; }
  };
}

test('devin batch: submitBatch creates one structured-output session per item', withDevinAuth(async () => {
  const stub = stubFetch([
    { status: 200, data: { session_id: 's-1' } },
    { status: 200, data: { session_id: 's-2' } },
  ]);
  const bodies = [devin.batchBody({ prompt: 'p0', label: 'l0' }), devin.batchBody({ prompt: 'p1', label: 'l1', schema: { type: 'object' } })];
  const r = await devin.submitBatch('swe-2-medium', bodies, { fetchImpl: stub.fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.batchId), ['s-1', 's-2']);
  assert.equal(stub.calls.length, 2);
  assert.equal(stub.calls[0].body.devin_mode, 'swe-2-medium');
  assert.equal(stub.calls[0].body.structured_output_required, true);
  assert.deepEqual(stub.calls[0].body.structured_output_schema.properties.answer, { type: 'string' });
  assert.deepEqual(stub.calls[1].body.structured_output_schema, { type: 'object' }); // item schema passed through
  assert.match(stub.calls[0].headers.Authorization, /Bearer test-devin-key/);
  assert.match(stub.calls[0].url, /\/v3\/organizations\/org-test\/sessions$/);
}));

test('devin batch: getBatch aggregates per-item states', withDevinAuth(async () => {
  // s-1 has output, s-2 still running -> in_progress
  const stub1 = stubFetch([
    { status: 200, data: { structured_output: { answer: 'A' }, status: 'running' } },
    { status: 200, data: { structured_output: null, status: 'running' } },
  ]);
  const r1 = await devin.getBatch(JSON.stringify(['s-1', 's-2']), { fetchImpl: stub1.fetchImpl });
  assert.equal(r1.status, 'in_progress');

  // s-1 output, s-2 errored terminal -> completed with per-item results
  const stub2 = stubFetch([
    { status: 200, data: { structured_output: { answer: 'A' }, status: 'running' } },
    { status: 200, data: { structured_output: null, status: 'error', status_detail: 'crashed' } },
  ]);
  const r2 = await devin.getBatch(JSON.stringify(['s-1', 's-2']), { fetchImpl: stub2.fetchImpl });
  assert.equal(r2.status, 'completed');
  const byId = devin.batchResultMap(r2.results);
  assert.deepEqual(byId.get('c0'), { structured_output: { answer: 'A' } });
  assert.match(byId.get('c1').error.message, /session error.*crashed/);
}));

test('devin batch: end-to-end aligned results + journal records', withDevinAuth(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([
      { status: 200, data: { session_id: 's-1' } },
      { status: 200, data: { session_id: 's-2' } },
      { status: 200, data: { structured_output: { answer: 'A' }, status: 'running' } },
      { status: 200, data: { structured_output: { answer: 'B' }, status: 'running' } },
    ]);
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'swe-2-medium'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const res = await f.run({ adapter: devin, fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', 'B']);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.equal(loaded.batches.length, 1);
    assert.deepEqual(JSON.parse(loaded.batches[0].batch_id), ['s-1', 's-2']);
    assert.equal(loaded.settled.get(0).result.text, 'A');
    assert.equal(loaded.settled.get(1).result.text, 'B');
  } finally { f.cleanup(); }
}));

test('devin batch: resume re-polls journaled session ids — zero new sessions', withDevinAuth(async () => {
  const f = fixture();
  try {
    const scriptPath = f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'swe-2-medium'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    // Seed bodies exactly as batch() builds them — default label is batch-<i>.
    const bodies = [{ prompt: 'p0' }, { prompt: 'p1' }].map((s, i) => devin.batchBody({ ...s, label: `batch-${i}`, model: 'swe-2-medium' }));
    const hash = createHash('sha256').update(JSON.stringify({ model: 'swe-2-medium', bodies })).digest('hex').slice(0, 16);
    const prior = Journal.create(f.dir, { runId: 'run-d', script: 'w.mjs', harness: 'devin' });
    prior.append({ type: 'batch', batch_id: JSON.stringify(['s-1', 's-2']), firstI: 0, count: 2, model: 'swe-2-medium', hash });
    prior.append({ type: 'run-end', reason: 'interrupted' });

    const stub = stubFetch([
      { status: 200, data: { structured_output: { answer: 'A' }, status: 'running' } },
      { status: 200, data: { structured_output: { answer: 'B' }, status: 'running' } },
    ]);
    const res = await f.run({ adapter: devin, resumeId: 'run-d', fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', 'B']);
    assert.equal(stub.calls.filter((c) => c.method === 'POST').length, 0);
    assert.match(stub.calls[0].url, /\/sessions\/s-1$/);
  } finally { f.cleanup(); }
}));

test('devin batch: partial submit failure settles only that index', withDevinAuth(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([
      { status: 200, data: { session_id: 's-1' } },
      { status: 500, data: { error: { message: 'quota exceeded' } } },
      { status: 200, data: { structured_output: { answer: 'A' }, status: 'running' } },
    ]);
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'swe-2-medium'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const res = await f.run({ adapter: devin, fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', null]);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.match(loaded.settled.get(1).error.message, /quota exceeded/);
  } finally { f.cleanup(); }
}));

test('devin batch: terminal session without output is a per-item error', withDevinAuth(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([
      { status: 200, data: { session_id: 's-1' } },
      { status: 200, data: { structured_output: null, status: 'suspended', status_detail: 'inactivity' } },
    ]);
    f.writeScript(`const r = await batch([{prompt:'p0'}], {model:'swe-2-medium'});
log('RESULT:' + JSON.stringify(r));`);
    const res = await f.run({ adapter: devin, fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), [null]);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.match(loaded.settled.get(0).error.message, /suspended.*without output/);
  } finally { f.cleanup(); }
}));

test('devin batch: missing cloud credentials fails cleanly', async () => {
  const f = fixture();
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'af-nohome-')); // hide CLI creds
    delete process.env.DEVIN_API_KEY;
    delete process.env.DEVIN_ORG_ID;
    const r = await devin.submitBatch('swe-2-medium', [{ prompt: 'p' }], { fetchImpl: async () => { throw new Error('must not fetch'); } });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /no cloud credentials/);
  } finally {
    process.env.HOME = savedHome;
    f.cleanup();
  }
});

// --- perplexity (async sonar requests, composite id like devin) ---

function withPplxKey(fn) {
  return async () => {
    process.env.PERPLEXITY_API_KEY = 'test-pplx';
    try { await fn(); } finally { delete process.env.PERPLEXITY_API_KEY; }
  };
}

const pplxDone = (text) => ({ status: 'COMPLETED', response: { choices: [{ message: { content: text } }] } });

test('perplexity batch: end-to-end aligned results + journal records', withPplxKey(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([
      { status: 200, data: { id: 'req-1', status: 'CREATED' } },
      { status: 200, data: { id: 'req-2', status: 'CREATED' } },
      { status: 200, data: pplxDone('A') },
      { status: 200, data: pplxDone('B') },
    ]);
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'sonar'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const res = await f.run({ adapter: perplexity, fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', 'B']);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.equal(loaded.batches.length, 1);
    assert.deepEqual(JSON.parse(loaded.batches[0].batch_id), ['req-1', 'req-2']);
    assert.equal(loaded.settled.get(0).result.text, 'A');
    assert.equal(loaded.settled.get(1).result.text, 'B');
  } finally { f.cleanup(); }
}));

test('perplexity batch: resume re-polls journaled request ids — zero new submits', withPplxKey(async () => {
  const f = fixture();
  try {
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'sonar'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const bodies = [{ prompt: 'p0' }, { prompt: 'p1' }].map((s, i) => perplexity.batchBody({ ...s, label: `batch-${i}`, model: 'sonar' }));
    const hash = createHash('sha256').update(JSON.stringify({ model: 'sonar', bodies })).digest('hex').slice(0, 16);
    const prior = Journal.create(f.dir, { runId: 'run-p', script: 'w.mjs', harness: 'perplexity' });
    prior.append({ type: 'batch', batch_id: JSON.stringify(['req-1', 'req-2']), firstI: 0, count: 2, model: 'sonar', hash });
    prior.append({ type: 'run-end', reason: 'interrupted' });

    const stub = stubFetch([
      { status: 200, data: pplxDone('A') },
      { status: 200, data: pplxDone('B') },
    ]);
    const res = await f.run({ adapter: perplexity, resumeId: 'run-p', fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', 'B']);
    assert.equal(stub.calls.filter((c) => c.method === 'POST').length, 0);
    assert.match(stub.calls[0].url, /\/v1\/async\/sonar\/req-1$/);
  } finally { f.cleanup(); }
}));

test('perplexity batch: per-item FAILED settles only that index', withPplxKey(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([
      { status: 200, data: { id: 'req-1' } },
      { status: 200, data: { id: 'req-2' } },
      { status: 200, data: pplxDone('A') },
      { status: 200, data: { status: 'FAILED', error_message: 'content filter' } },
    ]);
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'sonar'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const res = await f.run({ adapter: perplexity, fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', null]);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.match(loaded.settled.get(1).error.message, /content filter/);
  } finally { f.cleanup(); }
}));
// --- openai / anthropic (direct-API batch adapters — deterministic only) ---

function withOpenAI(fn) {
  return async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    try { await fn(); } finally { delete process.env.OPENAI_API_KEY; }
  };
}
function withAnthropic(fn) {
  return async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    try { await fn(); } finally { delete process.env.ANTHROPIC_API_KEY; }
  };
}

const openaiOut = (texts) => texts.map((t, i) => JSON.stringify(
  t == null
    ? { custom_id: `c${i}`, error: { code: 'server_error', message: 'upstream blew up' } }
    : { custom_id: `c${i}`, response: { status_code: 200, body: { choices: [{ message: { content: t } }] } } },
)).join('\n');

const anthropicOut = (texts) => texts.map((t, i) => JSON.stringify(
  t == null
    ? { custom_id: `c${i}`, result: { type: 'errored', error: { message: 'item blew up' } } }
    : { custom_id: `c${i}`, result: { type: 'succeeded', message: { content: [{ type: 'text', text: t }] } } },
)).join('\n');

test('openai batch: two-step submit, aligned results, journal records', withOpenAI(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([
      { status: 200, data: { id: 'file-1' } },
      { status: 200, data: { id: 'batch_1', status: 'validating' } },
      { status: 200, data: { status: 'completed', output_file_id: 'file-o', request_counts: { total: 2, completed: 2, failed: 0 } } },
      { status: 200, text: openaiOut(['A', 'B']) },
    ]);
    f.writeScript(`const r = await batch([{prompt:'p0',label:'x0'},{prompt:'p1',label:'x1'}], {model:'gpt-4.1-mini'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const res = await f.run({ adapter: openai, fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', 'B']);
    assert.deepEqual(stub.calls.map((c) => c.method), ['POST', 'POST', 'GET', 'GET']);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.equal(loaded.batches.length, 1);
    assert.equal(loaded.batches[0].batch_id, 'batch_1');
    assert.equal(loaded.settled.get(0).result.text, 'A');
  } finally { f.cleanup(); }
}));

test('openai batch: resume re-polls journaled batch_id — never resubmits', withOpenAI(async () => {
  const f = fixture();
  try {
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'gpt-4.1-mini'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const bodies = [{ prompt: 'p0' }, { prompt: 'p1' }].map((s) => openai.batchBody({ ...s, model: 'gpt-4.1-mini' }));
    const hash = createHash('sha256').update(JSON.stringify({ model: 'gpt-4.1-mini', bodies })).digest('hex').slice(0, 16);
    const prior = Journal.create(f.dir, { runId: 'run-o', script: 'w.mjs', harness: 'openai' });
    prior.append({ type: 'batch', batch_id: 'batch_old', firstI: 0, count: 2, model: 'gpt-4.1-mini', hash });
    prior.append({ type: 'run-end', reason: 'interrupted' });

    const stub = stubFetch([
      { status: 200, data: { status: 'completed', output_file_id: 'file-o', request_counts: { total: 2, completed: 2, failed: 0 } } },
      { status: 200, text: openaiOut(['A', 'B']) },
    ]);
    const res = await f.run({ adapter: openai, resumeId: 'run-o', fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', 'B']);
    assert.equal(stub.calls.filter((c) => c.method === 'POST').length, 0); // zero resubmits
    assert.equal(stub.calls[0].url.includes('batch_old'), true);
  } finally { f.cleanup(); }
}));

test('openai batch: per-item error settles only that index', withOpenAI(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([
      { status: 200, data: { id: 'file-1' } },
      { status: 200, data: { id: 'batch_1', status: 'validating' } },
      { status: 200, data: { status: 'completed', output_file_id: 'file-o', request_counts: { total: 2, completed: 1, failed: 1 } } },
      { status: 200, text: openaiOut(['A', null]) },
    ]);
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'gpt-4.1-mini'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const res = await f.run({ adapter: openai, fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', null]);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.match(loaded.settled.get(1).error.message, /upstream blew up/);
  } finally { f.cleanup(); }
}));

test('anthropic batch: one-call submit, ended->completed, aligned results', withAnthropic(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([
      { status: 200, data: { id: 'msgbatch_1', processing_status: 'in_progress' } },
      { status: 200, data: { processing_status: 'ended', results_url: 'http://stub/results', request_counts: { processing: 0, succeeded: 2, errored: 0, expired: 0, canceled: 0 } } },
      { status: 200, text: anthropicOut(['A', 'B']) },
    ]);
    f.writeScript(`const r = await batch([{prompt:'p0',label:'x0'},{prompt:'p1',label:'x1'}], {model:'claude-haiku-4-5'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const res = await f.run({ adapter: anthropic, fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', 'B']);
    assert.deepEqual(stub.calls.map((c) => c.method), ['POST', 'GET', 'GET']);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.equal(loaded.batches[0].batch_id, 'msgbatch_1');
    assert.equal(loaded.settled.get(1).result.text, 'B');
  } finally { f.cleanup(); }
}));

test('anthropic batch: resume re-polls journaled batch_id — never resubmits', withAnthropic(async () => {
  const f = fixture();
  try {
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'claude-haiku-4-5'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const bodies = [{ prompt: 'p0' }, { prompt: 'p1' }].map((s) => anthropic.batchBody({ ...s, model: 'claude-haiku-4-5' }));
    const hash = createHash('sha256').update(JSON.stringify({ model: 'claude-haiku-4-5', bodies })).digest('hex').slice(0, 16);
    const prior = Journal.create(f.dir, { runId: 'run-a', script: 'w.mjs', harness: 'anthropic' });
    prior.append({ type: 'batch', batch_id: 'msgbatch_old', firstI: 0, count: 2, model: 'claude-haiku-4-5', hash });
    prior.append({ type: 'run-end', reason: 'interrupted' });

    const stub = stubFetch([
      { status: 200, data: { processing_status: 'ended', results_url: 'http://stub/results', request_counts: { processing: 0, succeeded: 2, errored: 0, expired: 0, canceled: 0 } } },
      { status: 200, text: anthropicOut(['A', 'B']) },
    ]);
    const res = await f.run({ adapter: anthropic, resumeId: 'run-a', fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', 'B']);
    assert.equal(stub.calls.filter((c) => c.method === 'POST').length, 0);
    assert.equal(stub.calls[0].url.includes('msgbatch_old'), true);
  } finally { f.cleanup(); }
}));

test('anthropic batch: per-item errored settles only that index', withAnthropic(async () => {
  const f = fixture();
  try {
    const stub = stubFetch([
      { status: 200, data: { id: 'msgbatch_1', processing_status: 'in_progress' } },
      { status: 200, data: { processing_status: 'ended', results_url: 'http://stub/results', request_counts: { processing: 0, succeeded: 1, errored: 1, expired: 0, canceled: 0 } } },
      { status: 200, text: anthropicOut(['A', null]) },
    ]);
    f.writeScript(`const r = await batch([{prompt:'p0'},{prompt:'p1'}], {model:'claude-haiku-4-5'});
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const res = await f.run({ adapter: anthropic, fetchImpl: stub.fetchImpl });
    assert.equal(res.code, 0);
    assert.deepEqual(f.lastResult(), ['A', null]);
    const loaded = Journal.load(Journal.pathFor(f.dir, res.runId));
    assert.match(loaded.settled.get(1).error.message, /item blew up/);
  } finally { f.cleanup(); }
}));
