import test from 'node:test';
import assert from 'node:assert/strict';
import openrouter from '../src/adapters/openrouter.mjs';
import { spec } from './helpers.mjs';

// openrouter e2e without network: spec.fetchImpl replaces global fetch so the
// full response/error classification path runs deterministically. The key's
// presence is all that matters — fetch is mocked. (Each test file runs in its
// own process, so this can't leak into the no-key test in adapters.test.mjs.)
process.env.OPENROUTER_API_KEY = 'fakebin-test-key';
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const errResponse = (status, body = {}) => ({ ok: false, status, json: async () => body });

test('openrouter: 200 completion returns text, null json without schema', async () => {
  const r = await openrouter.spawnAgent(spec({
    fetchImpl: async () => okResponse({ choices: [{ message: { content: 'PONG' } }] }),
  }));
  assert.equal(r.ok, true);
  assert.equal(r.result.text, 'PONG');
  assert.equal(r.result.json, null);
});

test('openrouter: schema spec extracts json from content', async () => {
  const r = await openrouter.spawnAgent(spec({
    schema: { type: 'object' },
    fetchImpl: async () => okResponse({ choices: [{ message: { content: 'prose\n```json\n{"ok":true}\n```' } }] }),
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.json, { ok: true });
});

test('openrouter: 401/403 classify permissionDenied, 500 is plain error', async () => {
  for (const [status, denied] of [[401, true], [403, true], [500, false]]) {
    const r = await openrouter.spawnAgent(spec({ fetchImpl: async () => errResponse(status, { error: { message: 'nope' } }) }));
    assert.equal(r.ok, false);
    assert.equal(r.error.permissionDenied, denied, `status ${status}`);
    assert.match(r.error.message, /openrouter: nope/);
  }
});

test('openrouter: empty completion is an error (observed glm flake shape)', async () => {
  const r = await openrouter.spawnAgent(spec({ fetchImpl: async () => okResponse({ choices: [{ message: { content: '' } }] }) }));
  assert.equal(r.ok, false);
  assert.match(r.error.message, /empty completion/);
});

test('openrouter: fetch reject TimeoutError classifies timedOut', async () => {
  const r = await openrouter.spawnAgent(spec({
    fetchImpl: async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.error.timedOut, true);
});

test('openrouter: non-TimeoutError rejection is a plain error', async () => {
  const r = await openrouter.spawnAgent(spec({
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.error.timedOut, false);
  assert.match(r.error.message, /ECONNRESET/);
});

test('openrouter: request construction reaches fetch — method, signal, schema body', async () => {
  let seen;
  const r = await openrouter.spawnAgent(spec({
    schema: { type: 'object' },
    fetchImpl: async (url, init) => { seen = init; return okResponse({ choices: [{ message: { content: '{"ok":true}' } }] }); },
  }));
  assert.equal(r.ok, true);
  // Response mocks that discard init can't see a dropped signal or a body
  // built without the schema prompt — the silent production break this
  // verifies against.
  assert.equal(seen.method, 'POST');
  assert.ok(seen.signal instanceof AbortSignal);
  assert.equal(seen.signal.aborted, false);
  const body = JSON.parse(seen.body);
  assert.match(body.messages[0].content, /JSON object matching this schema/);
});

// Fake fetch: records calls, returns canned {status, data} responses.
function stubFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers ?? {} });
    const { status = 200, data = {} } = await respond(calls.at(-1));
    return { ok: status < 300, status, json: async () => data };
  };
  return { calls, fetchImpl };
}

function withKey(fn) {
  return async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    try { await fn(); } finally { delete process.env.OPENROUTER_API_KEY; }
  };
}

test('submitBatch posts {endpoint, model, custom_id-keyed requests}', withKey(async () => {
  const { calls, fetchImpl } = stubFetch(() => ({ status: 202, data: { id: 'b-1', status: 'validating' } }));
  const r = await openrouter.submitBatch('m/batch', [{ a: 1 }, { a: 2 }], { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.batchId, 'b-1');
  const sent = calls[0];
  assert.match(sent.url, /\/batches$/);
  assert.equal(sent.method, 'POST');
  assert.equal(sent.body.endpoint, '/v1/chat/completions');
  assert.equal(sent.body.model, 'm/batch');
  assert.equal(sent.body.requests.length, 2);
  assert.deepEqual(sent.body.requests.map((x) => x.custom_id), ['c0', 'c1']);
  assert.deepEqual(sent.body.requests[0].body, { a: 1 });
  assert.match(sent.headers.Authorization, /Bearer test-key/);
}));

test('submitBatch 400 error names the model; 401 is permissionDenied', withKey(async () => {
  const a = stubFetch(() => ({ status: 400, data: { error: { message: 'no batch endpoint' } } }));
  const r = await openrouter.submitBatch('m/nobatch', [{}], { fetchImpl: a.fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /m\/nobatch/);
  assert.equal(r.error.code, 400);
  assert.equal(r.error.permissionDenied, false);

  const b = stubFetch(() => ({ status: 401, data: { error: { message: 'bad key' } } }));
  const r2 = await openrouter.submitBatch('m/b', [{}], { fetchImpl: b.fetchImpl });
  assert.equal(r2.error.permissionDenied, true);
}));

test('getBatch passes through status + results/error verbatim', withKey(async () => {
  const { calls, fetchImpl } = stubFetch(() => ({
    data: { status: 'completed', results: [{ custom_id: 'c0', result: { choices: [{ message: { content: 'hi' } }] } }] },
  }));
  const r = await openrouter.getBatch('b-9', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'completed');
  assert.equal(r.results[0].custom_id, 'c0');
  assert.match(calls[0].url, /\/batches\/b-9$/);
  assert.equal(calls[0].method, 'GET');
}));

test('missing OPENROUTER_API_KEY fails cleanly on all entrypoints', async () => {
  delete process.env.OPENROUTER_API_KEY;
  const r = await openrouter.submitBatch('m', [{}], { fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /OPENROUTER_API_KEY not set/);
  const g = await openrouter.getBatch('b', { fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.match(g.error.message, /OPENROUTER_API_KEY not set/);
});

test('batchResultMap accepts array entries and object maps', () => {
  const arr = [{ custom_id: 'c0', result: { x: 1 } }, { custom_id: 'c1', response: { x: 2 } }];
  const m = openrouter.batchResultMap(arr);
  assert.deepEqual(m.get('c0'), { x: 1 });
  assert.deepEqual(m.get('c1'), { x: 2 });
  const obj = { c0: { result: { x: 3 } }, c1: { x: 4 } };
  const m2 = openrouter.batchResultMap(obj);
  assert.deepEqual(m2.get('c0'), { x: 3 });
  assert.deepEqual(m2.get('c1'), { x: 4 });
  assert.equal(openrouter.batchResultMap(null).size, 0);
});

test('batchItemResult maps entries to spawnAgent-shaped results', () => {
  const ok = openrouter.batchItemResult({ choices: [{ message: { content: '{"a":1}' } }] }, { schema: { type: 'object' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.result.json, { a: 1 });
  const itemErr = openrouter.batchItemResult({ error: { message: 'rate limited' } }, {});
  assert.equal(itemErr.ok, false);
  assert.match(itemErr.error.message, /rate limited/);
  const empty = openrouter.batchItemResult(undefined, {});
  assert.equal(empty.ok, false);
});
