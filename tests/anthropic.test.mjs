import test from 'node:test';
import assert from 'node:assert/strict';
import anthropic from '../src/adapters/anthropic.mjs';

// Deterministic fetch stub — records calls, replays queued responses.
// `text` responses return a string body (results_url JSONL path).
function stubFetch(queue) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({
      url,
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : null,
      headers: opts.headers ?? {},
    });
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
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try { await fn(); } finally { delete process.env.ANTHROPIC_API_KEY; }
};

test('anthropic buildBody: max_tokens default/override, single user message', () => {
  assert.deepEqual(anthropic.buildBody({ prompt: 'hi' }), {
    model: 'claude-haiku-4-5', max_tokens: 8192,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(anthropic.buildBody({ prompt: 'hi', model: 'm', maxTokens: 256 }).max_tokens, 256);
});

test('anthropic spawnAgent: POST /v1/messages, headers, text extraction, schema json', withKey(async () => {
  const { fetchImpl, calls } = stubFetch([
    { status: 200, data: { content: [{ type: 'text', text: 'hello' }] } },
  ]);
  const r = await anthropic.spawnAgent({ prompt: 'say hi', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.result.text, 'hello');
  const c = calls[0];
  assert.equal(c.method, 'POST');
  assert.match(c.url, /\/v1\/messages$/);
  assert.equal(c.headers['x-api-key'], 'sk-ant-test');
  assert.equal(c.headers['anthropic-version'], '2023-06-01');
  assert.equal(c.body.max_tokens, 8192);
  assert.deepEqual(c.body.messages, [{ role: 'user', content: 'say hi' }]);
}));

test('anthropic spawnAgent: schema prompt expansion + multi-block text join', withKey(async () => {
  const { fetchImpl, calls } = stubFetch([
    { status: 200, data: { content: [{ type: 'thinking', text: 'x' }, { type: 'text', text: '{"a": 1}' }] } },
  ]);
  const r = await anthropic.spawnAgent({ prompt: 'p', schema: { type: 'object' }, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.result.text, '{"a": 1}');
  assert.deepEqual(r.result.json, { a: 1 });
  assert.match(calls[0].body.messages[0].content, /Respond with only a JSON object/);
}));

test('anthropic spawnAgent: empty content + 401 permissionDenied', withKey(async () => {
  let r = await anthropic.spawnAgent({ prompt: 'p', fetchImpl: stubFetch([{ status: 200, data: { content: [] } }]).fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /empty completion/);
  r = await anthropic.spawnAgent({ prompt: 'p', fetchImpl: stubFetch([{ status: 401, data: { error: { message: 'bad key' } } }]).fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error.permissionDenied, true);
}));

test('anthropic submitBatch: one POST, requests carry custom_id c0..cN + params', withKey(async () => {
  const { fetchImpl, calls } = stubFetch([
    { status: 200, data: { id: 'msgbatch_1', processing_status: 'in_progress' } },
  ]);
  const bodies = [anthropic.batchBody({ prompt: 'p0' }), anthropic.batchBody({ prompt: 'p1', maxTokens: 64 })];
  const r = await anthropic.submitBatch('claude-haiku-4-5', bodies, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.batchId, 'msgbatch_1');
  const c = calls[0];
  assert.match(c.url, /\/v1\/messages\/batches$/);
  assert.equal(c.headers['anthropic-beta'], 'message-batches-2024-09-24');
  assert.equal(c.body.requests.length, 2);
  assert.equal(c.body.requests[0].custom_id, 'c0');
  assert.equal(c.body.requests[1].custom_id, 'c1');
  assert.equal(c.body.requests[1].params.max_tokens, 64);
  assert.equal(c.body.requests[0].params.model, 'claude-haiku-4-5');
}));

test('anthropic getBatch: in_progress passthrough with counts', withKey(async () => {
  const { fetchImpl } = stubFetch([
    { status: 200, data: { processing_status: 'in_progress', request_counts: { processing: 3, succeeded: 1, errored: 0, expired: 0, canceled: 0 } } },
  ]);
  const r = await anthropic.getBatch('msgbatch_1', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'in_progress');
  assert.deepEqual(r.counts, { pending: 3, settled: 1, total: 4 });
}));

test('anthropic getBatch: ended -> completed, fetches results_url JSONL, maps per-item outcomes', withKey(async () => {
  const jsonl = [
    JSON.stringify({ custom_id: 'c0', result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'A' }] } } }),
    JSON.stringify({ custom_id: 'c1', result: { type: 'errored', error: { type: 'invalid_request', message: 'bad item' } } }),
    JSON.stringify({ custom_id: 'c2', result: { type: 'expired' } }),
  ].join('\n');
  const { fetchImpl, calls } = stubFetch([
    { status: 200, data: { processing_status: 'ended', results_url: 'https://api.anthropic.com/v1/messages/batches/msgbatch_1/results', request_counts: { processing: 0, succeeded: 1, errored: 1, expired: 1, canceled: 0 } } },
    { status: 200, text: jsonl },
  ]);
  const r = await anthropic.getBatch('msgbatch_1', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'completed');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.anthropic.com/v1/messages/batches/msgbatch_1/results');
  assert.equal(calls[1].headers['x-api-key'], 'sk-ant-test');
  assert.equal(r.results.length, 3);
  const byId = anthropic.batchResultMap(r.results);
  const ok0 = anthropic.batchItemResult(byId.get('c0'), {});
  assert.equal(ok0.ok, true);
  assert.equal(ok0.result.text, 'A');
  const e1 = anthropic.batchItemResult(byId.get('c1'), {});
  assert.equal(e1.ok, false);
  assert.match(e1.error.message, /bad item/);
  const e2 = anthropic.batchItemResult(byId.get('c2'), {});
  assert.equal(e2.ok, false);
  assert.match(e2.error.message, /expired/);
}));

test('anthropic getBatch: canceling stays non-terminal; missing key fails clean', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    const { fetchImpl } = stubFetch([{ status: 200, data: { processing_status: 'canceling' } }]);
    const r = await anthropic.getBatch('b', { fetchImpl });
    assert.equal(r.status, 'canceling');
  } finally { delete process.env.ANTHROPIC_API_KEY; }
  const noKey = await anthropic.getBatch('b', {});
  assert.equal(noKey.ok, false);
  assert.match(noKey.error.message, /ANTHROPIC_API_KEY/);
  const noKey2 = await anthropic.submitBatch('m', [], {});
  assert.equal(noKey2.ok, false);
  assert.match(noKey2.error.message, /ANTHROPIC_API_KEY/);
  const noKey3 = await anthropic.spawnAgent({ prompt: 'p' });
  assert.equal(noKey3.ok, false);
  assert.match(noKey3.error.message, /ANTHROPIC_API_KEY/);
});
