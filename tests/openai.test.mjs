import test from 'node:test';
import assert from 'node:assert/strict';
import openai from '../src/adapters/openai.mjs';

// Deterministic fetch stub — records calls (FormData bodies flattened to
// entries; file parts read to text), replays queued responses.
function stubFetch(queue) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    let body = opts.body;
    if (body instanceof FormData) {
      body = {};
      for (const [k, v] of opts.body.entries()) body[k] = v instanceof Blob ? await v.text() : v;
    } else if (typeof body === 'string') body = JSON.parse(body);
    calls.push({ url, method: opts.method ?? 'GET', body, headers: opts.headers ?? {} });
    const n = queue.shift();
    if (!n) throw new Error(`unstubbed fetch: ${opts.method ?? 'GET'} ${url}`);
    return {
      ok: n.status < 300,
      status: n.status,
      json: async () => n.data,
      text: async () => n.text ?? JSON.stringify(n.data),
    };
  };
  return { fetchImpl, calls };
}

const withKey = (fn) => async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  try { await fn(); } finally { delete process.env.OPENAI_API_KEY; }
};

test('openai buildBody: default model, single user message', () => {
  assert.deepEqual(openai.buildBody({ prompt: 'hi' }), {
    model: 'gpt-4.1-mini',
    messages: [{ role: 'user', content: 'hi' }],
  });
});

test('openai spawnAgent: POST /v1/chat/completions, bearer header, text + schema json', withKey(async () => {
  const { fetchImpl, calls } = stubFetch([
    { status: 200, data: { choices: [{ message: { content: '{"x":2}' } }] } },
  ]);
  const r = await openai.spawnAgent({ prompt: 'p', schema: { type: 'object' }, fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.json, { x: 2 });
  const c = calls[0];
  assert.equal(c.method, 'POST');
  assert.match(c.url, /\/v1\/chat\/completions$/);
  assert.equal(c.headers.Authorization, 'Bearer sk-test');
  assert.match(c.body.messages[0].content, /Respond with only a JSON object/);
}));

test('openai spawnAgent: empty + 403 permissionDenied', withKey(async () => {
  let r = await openai.spawnAgent({ prompt: 'p', fetchImpl: stubFetch([{ status: 200, data: { choices: [{ message: { content: '  ' } }] } }]).fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /empty completion/);
  r = await openai.spawnAgent({ prompt: 'p', fetchImpl: stubFetch([{ status: 403, data: { error: { message: 'no access' } } }]).fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error.permissionDenied, true);
}));

test('openai submitBatch: exactly two calls — JSONL upload then create', withKey(async () => {
  const { fetchImpl, calls } = stubFetch([
    { status: 200, data: { id: 'file-abc' } },
    { status: 200, data: { id: 'batch_1', status: 'validating' } },
  ]);
  const bodies = [openai.batchBody({ prompt: 'p0' }), openai.batchBody({ prompt: 'p1' })];
  const r = await openai.submitBatch('gpt-4.1-mini', bodies, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.batchId, 'batch_1');
  assert.equal(calls.length, 2);

  const up = calls[0];
  assert.match(up.url, /\/v1\/files$/);
  assert.equal(up.body.purpose, 'batch');
  const lines = up.body.file.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].custom_id, 'c0');
  assert.equal(lines[1].custom_id, 'c1');
  assert.equal(lines[0].method, 'POST');
  assert.equal(lines[0].url, '/v1/chat/completions');
  assert.deepEqual(lines[0].body.messages, [{ role: 'user', content: 'p0' }]);

  const mk = calls[1];
  assert.match(mk.url, /\/v1\/batches$/);
  assert.equal(mk.body.input_file_id, 'file-abc');
  assert.equal(mk.body.endpoint, '/v1/chat/completions');
  assert.equal(mk.body.completion_window, '24h');
}));

test('openai submitBatch: upload failure short-circuits before create', withKey(async () => {
  const { fetchImpl, calls } = stubFetch([{ status: 429, data: { error: { message: 'rate limited' } } }]);
  const r = await openai.submitBatch('gpt-4.1-mini', [openai.batchBody({ prompt: 'p' })], { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /batch file upload/);
  assert.equal(calls.length, 1); // no create attempted
}));

test('openai getBatch: non-terminal passthrough with counts; no file fetch', withKey(async () => {
  const { fetchImpl, calls } = stubFetch([
    { status: 200, data: { status: 'in_progress', request_counts: { total: 4, completed: 1, failed: 0 } } },
  ]);
  const r = await openai.getBatch('batch_1', { fetchImpl });
  assert.equal(r.status, 'in_progress');
  assert.deepEqual(r.counts, { pending: 3, settled: 1, total: 4 });
  assert.equal(calls.length, 1);
}));

test('openai getBatch: completed -> fetches output_file_id once, maps response/error entries', withKey(async () => {
  const jsonl = [
    JSON.stringify({ custom_id: 'c0', response: { status_code: 200, body: { choices: [{ message: { content: 'A' } }] } } }),
    JSON.stringify({ custom_id: 'c1', response: { status_code: 429, body: { error: { message: 'rate limited' } } } }),
    JSON.stringify({ custom_id: 'c2', error: { code: 'server_error', message: 'upstream blew up' } }),
  ].join('\n');
  const { fetchImpl, calls } = stubFetch([
    { status: 200, data: { status: 'completed', output_file_id: 'file-out', request_counts: { total: 3, completed: 1, failed: 2 } } },
    { status: 200, text: jsonl },
  ]);
  const r = await openai.getBatch('batch_1', { fetchImpl });
  assert.equal(r.status, 'completed');
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/v1\/files\/file-out\/content$/);
  const byId = openai.batchResultMap(r.results);
  assert.equal(openai.batchItemResult(byId.get('c0'), {}).result.text, 'A');
  const e1 = openai.batchItemResult(byId.get('c1'), {});
  assert.equal(e1.ok, false);
  assert.match(e1.error.message, /rate limited/);
  const e2 = openai.batchItemResult(byId.get('c2'), {});
  assert.equal(e2.ok, false);
  assert.match(e2.error.message, /upstream blew up/);
}));

test('openai getBatch: failed/expired stay terminal statuses for the runtime', withKey(async () => {
  for (const status of ['failed', 'expired', 'cancelled']) {
    const { fetchImpl, calls } = stubFetch([{ status: 200, data: { status, request_counts: { total: 2, completed: 0, failed: 2 } } }]);
    const r = await openai.getBatch('b', { fetchImpl });
    assert.equal(r.status, status);
    assert.equal(calls.length, 1); // no output fetch
  }
}));

test('openai: missing OPENAI_API_KEY fails clean on all entrypoints', async () => {
  for (const r of [
    await openai.spawnAgent({ prompt: 'p' }),
    await openai.submitBatch('m', [], {}),
    await openai.getBatch('b', {}),
  ]) {
    assert.equal(r.ok, false);
    assert.match(r.error.message, /OPENAI_API_KEY/);
  }
});
