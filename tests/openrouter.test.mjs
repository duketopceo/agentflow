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
