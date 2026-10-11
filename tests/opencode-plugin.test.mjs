import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunArgs, buildDoctorArgs } from '../plugins/agentflow/args.mjs';

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