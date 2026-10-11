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
  assert.doesNotMatch(out, /^\s*$/, 'output must not be blank on failure');
});

test('runAgentflow: argv reaches the stub in the documented order', async () => {
  const file = join(tmpdir(), `af-argv-${process.pid}.txt`);
  const argvFile = file;
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

// --- Dual-arm shape --------------------------------------------------------
//
// The migration guide's "Support V1 and V2 from one package" shape is the
// whole point of this entry: one default export carrying the v2
// Plugin.define (id + setup) alongside the v1 `server()` plugin function.
// These assertions pin that surface so a future edit cannot silently drop an
// arm or leave the module unloadable.

test('plugin module: default export carries both v2 and v1 surfaces', async () => {
  const mod = await import('../plugins/agentflow/index.ts');
  const d = mod.default;
  assert.equal(typeof d, 'object', 'default export must be the dual module object');
  assert.equal(d.id, 'agentflow', 'v2 arm identified by a stable id');
  assert.equal(typeof d.setup, 'function', 'v2 arm exposes setup(ctx)');
  assert.equal(typeof d.server, 'function', 'v1 arm exposes server() plugin function');
});

test('plugin module: v1 arm registers both tools and returns run output with a run-id', async () => {
  const mod = await import('../plugins/agentflow/index.ts');
  const hooks = await withFakebin(() => mod.default.server({ directory: tmpdir() }));
  assert.deepEqual(Object.keys(hooks.tool).sort(), ['agentflow_doctor', 'agentflow_run']);
  const out = await withFakebin(() => hooks.tool.agentflow_run.execute({ script: 'w.mjs' }));
  assert.ok(out.length > 0, 'v1 run output must not be empty on success');
  assert.match(out, /\[agentflow\] run /, 'v1 run output must include the run-id');
});
