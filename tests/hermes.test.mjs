import test from 'node:test';
import assert from 'node:assert/strict';
import hermes from '../src/adapters/hermes.mjs';
import { adapters } from '../src/adapters/index.mjs';
import { withFakebin, spec } from './helpers.mjs';

test('hermes registered in the adapter index', () => {
  assert.ok(adapters.hermes);
});

test('hermes buildArgv: -z one-shot, no autonomy flag without explicit model', () => {
  const argv = hermes.buildArgv(spec());
  assert.deepEqual(argv.slice(0, 4), ['hermes', '--cli', '-z', 'review this file']);
  // --safe-mode requires an explicit --model (live-verified refusal otherwise),
  // so a model-less spec carries no autonomy flag at all.
  assert.ok(!argv.includes('--safe-mode'));
  assert.ok(!argv.includes('--yolo'));
});

test('hermes buildArgv: explicit model -> --safe-mode default', () => {
  const argv = hermes.buildArgv(spec({ model: 'z-ai/glm-4.5-air' }));
  assert.ok(argv.includes('-m') && argv.includes('z-ai/glm-4.5-air'));
  assert.ok(argv.includes('--safe-mode'));
  assert.ok(!argv.includes('--yolo'));
});

test('hermes buildArgv: model, provider, reasoning, escalated -> --yolo', () => {
  const argv = hermes.buildArgv(spec({
    model: 'z-ai/glm-4.5-air',
    provider: 'openrouter',
    reasoningEffort: 'high',
    permission: 'escalated',
  }));
  assert.ok(argv.includes('-m') && argv.includes('z-ai/glm-4.5-air'));
  assert.ok(argv.includes('--provider') && argv.includes('openrouter'));
  assert.ok(argv.includes('--reasoning') && argv.includes('high'));
  assert.ok(argv.includes('--yolo'));
  assert.ok(!argv.includes('--safe-mode'));
});

test('hermes parse: plain stdout text + schema extraction', () => {
  const r = hermes.parse({ stdout: 'PONG\n' }, spec());
  assert.equal(r.text, 'PONG');
  assert.equal(r.json, null);
  const withSchema = hermes.parse({ stdout: '```json\n{"ok":true}\n```' }, spec({ schema: { type: 'object' } }));
  assert.deepEqual(withSchema.json, { ok: true });
});

test('hermes parse: empty output -> null (schema error path)', () => {
  assert.equal(hermes.parse({ stdout: '' }, spec()), null);
});

test('hermes spawnAgent e2e via fakebin: ok + schema paths', async () => {
  await withFakebin(async () => {
    const ok = await hermes.spawnAgent(spec());
    assert.equal(ok.ok, true);
    assert.equal(ok.result.text, 'PONG');

    const schema = await hermes.spawnAgent(spec({ schema: { type: 'object', properties: { ok: { type: 'boolean' } } } }));
    assert.equal(schema.ok, true);
    assert.deepEqual(schema.result.json, { ok: true });
  });
});

test('hermes spawnAgent e2e via fakebin: deny path classified as permissionDenied', async () => {
  await withFakebin(async () => {
    const denied = await hermes.spawnAgent(spec());
    assert.equal(denied.ok, false);
    assert.equal(denied.error.permissionDenied, true);
  }, { FAKEBIN_DENY: '1' });
});

test('hermes spawnAgent e2e via fakebin: forced failure is classified, not thrown', async () => {
  await withFakebin(async () => {
    const bad = await hermes.spawnAgent(spec());
    assert.equal(bad.ok, false);
    assert.equal(bad.error.timedOut, false);
    assert.equal(bad.error.permissionDenied, false);
    assert.match(bad.error.message, /exit 3/);
  }, { FAKEBIN_EXIT: '3' });
});
