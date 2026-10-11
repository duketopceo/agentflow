import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunArgs, buildDoctorArgs, runAgentflow } from '../plugins/agentflow/args.mjs';
import { withFakebin } from './helpers.mjs';

// The argv builder is the shared contract both plugin version arms assemble
// their invocation from. These tests pin its shape without needing a live
// OpenCode, an API key, or a real run.
test('buildRunArgs: minimal spec is just run + script, no trailing separator', () => {
  assert.deepEqual(buildRunArgs({ script: 'w.mjs' }), ['run', 'w.mjs']);
});

test('buildRunArgs: harness flag is placed after the script', () => {
  assert.deepEqual(
    buildRunArgs({ script: 'w.mjs', harness: 'devin' }),
    ['run', 'w.mjs', '--harness', 'devin'],
  );
});

test('buildRunArgs: via flag follows harness', () => {
  assert.deepEqual(
    buildRunArgs({ script: 'w.mjs', harness: 'claude', via: 'ori' }),
    ['run', 'w.mjs', '--harness', 'claude', '--via', 'ori'],
  );
});

test('buildRunArgs: scriptArgs are placed after the -- separator', () => {
  assert.deepEqual(
    buildRunArgs({ script: 'w.mjs', scriptArgs: 'do the thing' }),
    ['run', 'w.mjs', '--', 'do the thing'],
  );
});

test('buildRunArgs: all optional fields compose in runner order', () => {
  assert.deepEqual(
    buildRunArgs({ script: 'w.mjs', harness: 'devin', via: 'ori', scriptArgs: 'q' }),
    ['run', 'w.mjs', '--harness', 'devin', '--via', 'ori', '--', 'q'],
  );
});

test('buildRunArgs: empty optional values emit no flag and no trailing --', () => {
  // Guards the malformed-invocation case: an empty scriptArgs must not leave a
  // bare `--` that the runner would read as an empty args array.
  assert.deepEqual(
    buildRunArgs({ script: 'w.mjs', harness: '', via: '', scriptArgs: '' }),
    ['run', 'w.mjs'],
  );
});

test('buildDoctorArgs: doctor takes no positional and no flags', () => {
  assert.deepEqual(buildDoctorArgs(), ['doctor']);
});
// --- U2: the capture contract -----------------------------------------------
//
// These are the regression tests for the shipped defect: the v1 plugin read
// stdout only, so every successful run returned "" and the caller lost the
// run-id needed to resume or stop. The fake agentflow stub (tests/fakebin/
// agentflow) reproduces the real runner's contract — stdout empty, everything
// on stderr — so a stdout-only capture fails here.

test('runAgentflow: a stderr-only run still yields non-empty output containing the run-id', async () => {
  const { code, out } = await withFakebin(() =>
    runAgentflow(buildRunArgs({ script: 'w.mjs' }), { cwd: tmpdir(), bin: 'agentflow' }),
  );
  assert.equal(code, 0);
  assert.ok(out.length > 0, 'capture must not be empty for a successful run');
  assert.match(out, /\[agentflow\] run fake-run-0001/, 'run-id must survive the capture');
  assert.match(out, /RESULT:/, 'script log() output must survive the capture');
});

test('runAgentflow: nonzero exit surfaces the stderr reason, not a bare code', async () => {
  const { code, out } = await withFakebin(
    () => runAgentflow(buildRunArgs({ script: 'w.mjs' }), { cwd: tmpdir(), bin: 'agentflow' }),
    { AGENTFLOW_FAKE_EXIT: '3' },
  );
  assert.equal(code, 3);
  assert.match(out, /script failed with reason FAKED/, 'failure reason must be visible');
});

test('runAgentflow: argv reaches the stub in the documented order', async () => {
  const argvFile = join(tmpdir(), `af-argv-${process.pid}.txt`);
  await withFakebin(
    () => runAgentflow(
      buildRunArgs({ script: 'w.mjs', harness: 'devin', via: 'ori', scriptArgs: 'q' }),
      { cwd: tmpdir(), bin: 'agentflow' },
    ),
    { AGENTFLOW_FAKE_ARGV_FILE: argvFile },
  );
  const line = readFileSync(argvFile, 'utf8').trim();
  assert.equal(line, 'run w.mjs --harness devin --via ori -- q');
});

test('runAgentflow: doctor returns non-empty combined output', async () => {
  const { code, out } = await withFakebin(() =>
    runAgentflow(buildDoctorArgs(), { cwd: tmpdir(), bin: 'agentflow' }),
  );
  assert.equal(code, 0);
  assert.match(out, /test adapter/);
});


// --- v1 entry --------------------------------------------------------------

// Node <22.18 cannot import .ts (no type stripping) — the entry tests below
// load the real plugin files, so gate them on the runtime capability.
const canImportTs = typeof process.features?.typescript === 'string';

test('v1 entry: default export exposes the server() plugin function', { skip: !canImportTs }, async () => {
  const mod = await import('../plugins/agentflow/v1.ts');
  assert.equal(typeof mod.default.server, 'function');
});

test('v1 entry: registers both tools and returns run output carrying the run-id', { skip: !canImportTs }, async () => {
  const mod = await import('../plugins/agentflow/v1.ts');
  const hooks = await withFakebin(() => mod.default.server({ directory: tmpdir() }));
  assert.deepEqual(Object.keys(hooks.tool).sort(), ['agentflow_doctor', 'agentflow_run']);
  const out = await withFakebin(() => hooks.tool.agentflow_run.execute({ script: 'w.mjs' }));
  assert.ok(out.length > 0, 'v1 run output must not be empty on success');
  assert.match(out, /\[agentflow\] run /, 'v1 run output must include the run-id');
});

// --- v2 entry --------------------------------------------------------------

test('v2 entry: default export is a Plugin.define with a stable id and setup', { skip: !canImportTs }, async () => {
  const mod = await import('../plugins/agentflow/v2.ts');
  assert.equal(mod.default.id, 'agentflow', 'v2 plugin needs a stable id for storage scoping');
  assert.equal(typeof mod.default.setup, 'function');
});

test('v2 entry: setup() registers both tools against a real ctx.tool transform', { skip: !canImportTs }, async () => {
  const mod = await import('../plugins/agentflow/v2.ts');
  const added = [];
  const disposed = { called: false };
  const ctx = {
    location: { directory: tmpdir() },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => added.push(t) });
        return { dispose: async () => { disposed.called = true; } };
      },
    },
  };
  const cleanup = await withFakebin(() => mod.default.setup(ctx));
  assert.deepEqual(added.map((t) => t.name).sort(), ['agentflow_doctor', 'agentflow_run']);
  // The registration must be retained so a reload disposes rather than stacks.
  await cleanup();
  assert.ok(disposed.called, 'setup must return a cleanup that disposes the registration');
});

test('v2 entry: setup() degrades quietly when the context has no tool domain', { skip: !canImportTs }, async () => {
  // Regression guard. An earlier draft called ctx.tool.transform unguarded and
  // threw `Cannot read properties of undefined` — and because setup is awaited
  // at load, that kills the plugin instead of degrading it.
  const mod = await import('../plugins/agentflow/v2.ts');
  const ctx = { location: { directory: tmpdir() } };
  await assert.doesNotReject(() => mod.default.setup(ctx));
});

test('v2 entry: run tool returns { content } and captures the run-id', { skip: !canImportTs }, async () => {
  const mod = await import('../plugins/agentflow/v2.ts');
  const added = [];
  const ctx = {
    location: { directory: tmpdir() },
    tool: { transform: async (cb) => { cb({ add: (t) => added.push(t) }); return { dispose: async () => {} }; } },
  };
  await withFakebin(() => mod.default.setup(ctx));
  const run = added.find((t) => t.name === 'agentflow_run');
  const res = await withFakebin(() => run.execute({ script: 'w.mjs' }));
  assert.ok(typeof res.content === 'string' && res.content.length > 0, 'v2 run must return non-empty content');
  assert.match(res.content, /\[agentflow\] run /);
});

// --- failure surfacing -----------------------------------------------------

test('runAgentflow: a missing agentflow binary is named, not reported as "exited 1"', async () => {
  const { code, out } = await runAgentflow(['doctor'], { cwd: tmpdir(), bin: 'agentflow-does-not-exist' });
  assert.equal(code, 127);
  assert.match(out, /not found on PATH/, 'the ENOENT case must name the real cause');
});
