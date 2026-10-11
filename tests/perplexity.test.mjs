import test from 'node:test';
import assert from 'node:assert/strict';
import perplexity from '../src/adapters/perplexity.mjs';

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
    process.env.PERPLEXITY_API_KEY = 'test-key';
    try { await fn(); } finally { delete process.env.PERPLEXITY_API_KEY; }
  };
}

test('spawnAgent posts chat/completions and returns text + citations', withKey(async () => {
  const { calls, fetchImpl } = stubFetch(() => ({
    data: {
      choices: [{ message: { content: ' grounded answer ' } }],
      citations: ['https://a.example', 'https://b.example'],
    },
  }));
  const r = await perplexity.spawnAgent({ prompt: 'q?', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.result.text, 'grounded answer');
  assert.deepEqual(r.result.citations, ['https://a.example', 'https://b.example']);
  const sent = calls[0];
  assert.match(sent.url, /\/chat\/completions$/);
  assert.equal(sent.body.model, 'sonar');
  assert.equal(sent.body.messages[0].content, 'q?');
  assert.match(sent.headers.Authorization, /Bearer test-key/);
}));

test('spawnAgent: model/schema opts; empty completion and HTTP errors', withKey(async () => {
  const ok = stubFetch(() => ({ data: { choices: [{ message: { content: '{"a":1}' } }] } }));
  const r = await perplexity.spawnAgent({ prompt: 'x', model: 'sonar-pro', schema: { type: 'object' }, fetchImpl: ok.fetchImpl });
  assert.equal(ok.calls[0].body.model, 'sonar-pro');
  assert.match(ok.calls[0].body.messages[0].content, /Respond with only a JSON object/);
  assert.deepEqual(r.result.json, { a: 1 });

  const empty = stubFetch(() => ({ data: { choices: [{ message: { content: '' } }] } }));
  const r2 = await perplexity.spawnAgent({ prompt: 'x', fetchImpl: empty.fetchImpl });
  assert.equal(r2.ok, false);
  assert.match(r2.error.message, /empty completion/);

  const denied = stubFetch(() => ({ status: 401, data: { error: { message: 'bad key' } } }));
  const r3 = await perplexity.spawnAgent({ prompt: 'x', fetchImpl: denied.fetchImpl });
  assert.equal(r3.error.permissionDenied, true);
}));

test('submitBatch creates one async sonar request per item → composite id', withKey(async () => {
  const { calls, fetchImpl } = stubFetch((c) => ({ data: { id: `req-${calls.length}`, status: 'CREATED' } }));
  const bodies = [perplexity.batchBody({ prompt: 'p0' }), perplexity.batchBody({ prompt: 'p1', schema: { type: 'object' } })];
  const r = await perplexity.submitBatch('sonar', bodies, { fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.batchId), ['req-1', 'req-2']);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/v1\/async\/sonar$/);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.request.model, 'sonar');
  assert.match(calls[1].body.request.messages[0].content, /Respond with only a JSON object/);
  assert.match(calls[0].headers.Authorization, /Bearer test-key/);
}));

test('submitBatch: all-fail collapses to an error; partial keeps the slot', withKey(async () => {
  const allBad = stubFetch(() => ({ status: 500, data: { error: { message: 'boom' } } }));
  const r = await perplexity.submitBatch('sonar', [{}], { fetchImpl: allBad.fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /every async submit failed.*boom/);

  let n = 0;
  const partial = stubFetch(() => (n++ === 0 ? { data: { id: 'req-a' } } : { status: 429, data: { error: { message: 'rate limited' } } }));
  const r2 = await perplexity.submitBatch('sonar', [{}, {}], { fetchImpl: partial.fetchImpl });
  assert.equal(r2.ok, true);
  assert.deepEqual(JSON.parse(r2.batchId), ['req-a', { error: 'perplexity: rate limited' }]);
}));

test('getBatch aggregates per-item states into in_progress / completed', withKey(async () => {
  const completion = (text) => ({ choices: [{ message: { content: text } }] });
  const stub = stubFetch((c) => (c.url.endsWith('/req-1')
    ? { data: { status: 'COMPLETED', response: completion('A') } }
    : { data: { status: 'IN_PROGRESS' } }));
  const r = await perplexity.getBatch(JSON.stringify(['req-1', 'req-2']), { fetchImpl: stub.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'in_progress');
  assert.match(stub.calls[0].url, /\/v1\/async\/sonar\/req-1$/);

  const stub2 = stubFetch((c) => (c.url.endsWith('/req-1')
    ? { data: { status: 'COMPLETED', response: completion('A'), citations: ['https://x.example'] } }
    : { data: { status: 'FAILED', error_message: 'content filter' } }));
  const r2 = await perplexity.getBatch(JSON.stringify(['req-1', 'req-2']), { fetchImpl: stub2.fetchImpl });
  assert.equal(r2.status, 'completed');
  const byId = perplexity.batchResultMap(r2.results);
  assert.equal(byId.get('c0').choices[0].message.content, 'A');
  assert.equal(byId.get('c1').error.message, 'content filter');
}));

test('getBatch: dead request id and malformed slots are per-item errors', withKey(async () => {
  const stub = stubFetch((c) => (c.url.endsWith('/req-dead')
    ? { status: 404, data: { error: { message: 'not found' } } }
    : { data: { status: 'COMPLETED', response: { choices: [{ message: { content: 'A' } }] } } }));
  const r = await perplexity.getBatch(JSON.stringify(['req-dead', { error: 'submit failed' }, null]), { fetchImpl: stub.fetchImpl });
  // all three settle (none pending) → completed
  assert.equal(r.status, 'completed');
  const byId = perplexity.batchResultMap(r.results);
  assert.match(byId.get('c0').error.message, /not found/);
  assert.match(byId.get('c1').error.message, /submit failed/);
  assert.match(byId.get('c2').error.message, /malformed batch slot/);
}));

test('batchItemResult maps response → {text,json,citations}', () => {
  const ok = perplexity.batchItemResult(
    { choices: [{ message: { content: '{"a":1}' } }], citations: ['https://c.example'] },
    { schema: { type: 'object' } },
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.result.json, { a: 1 });
  assert.deepEqual(ok.result.citations, ['https://c.example']);
  const err = perplexity.batchItemResult({ error: { message: 'content filter' } }, {});
  assert.equal(err.ok, false);
  assert.match(err.error.message, /content filter/);
  assert.equal(perplexity.batchItemResult(undefined, {}).ok, false);
});

test('missing PERPLEXITY_API_KEY fails cleanly on all entrypoints', async () => {
  delete process.env.PERPLEXITY_API_KEY;
  const noFetch = async () => { throw new Error('must not fetch'); };
  const s = await perplexity.spawnAgent({ prompt: 'x', fetchImpl: noFetch });
  assert.match(s.error.message, /PERPLEXITY_API_KEY not set/);
  const b = await perplexity.submitBatch('sonar', [{}], { fetchImpl: noFetch });
  assert.match(b.error.message, /PERPLEXITY_API_KEY not set/);
  const g = await perplexity.getBatch('[]', { fetchImpl: noFetch });
  assert.match(g.error.message, /PERPLEXITY_API_KEY not set/);
});
