import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFakebin, spec } from './helpers.mjs';
import devin from '../src/adapters/devin.mjs';
import claude from '../src/adapters/claude.mjs';
import codex from '../src/adapters/codex.mjs';
import opencode from '../src/adapters/opencode.mjs';
import ori from '../src/adapters/ori.mjs';
import { runScript } from '../src/runtime.mjs';
import { Journal } from '../src/journal.mjs';

// End-to-end adapter coverage through the real spawn path: fake binaries on
// PATH emit each harness's contract output, so argv -> spawn -> classify ->
// parse is exercised with no real harness installed. This is the seam the
// via-wrap-contract learning says argv-only tests cannot see.
test('fakebin: every subprocess adapter settles ok with contract output', async () => {
  await withFakebin(async () => {
    for (const adapter of [devin, claude, codex, opencode, ori]) {
      const r = await adapter.spawnAgent(spec());
      assert.equal(r.ok, true, `${adapter.name}: ${JSON.stringify(r.error)}`);
      assert.match(r.result.text, /PONG/, adapter.name);
    }
  });
});

test('fakebin codex: result captured from -o file, not stdout', async () => {
  await withFakebin(async () => {
    const r = await codex.spawnAgent(spec());
    assert.equal(r.ok, true);
    assert.equal(r.result.text, 'PONG'); // stub writes PONG to file, events to stdout
  });
});

test('fakebin: schema specs produce parsed json per adapter mechanism', async () => {
  await withFakebin(async () => {
    const s = spec({ schema: { type: 'object' } });
    for (const adapter of [devin, claude, codex, opencode, ori]) {
      const r = await adapter.spawnAgent(s);
      assert.equal(r.ok, true, `${adapter.name}: ${JSON.stringify(r.error)}`);
      assert.deepEqual(r.result.json, { ok: true }, adapter.name);
    }
  });
});

test('fakebin: forced exit classifies as error, not crash', async () => {
  await withFakebin(async () => {
    const r = await devin.spawnAgent(spec());
    assert.equal(r.ok, false);
    assert.match(r.error.message, /exit 1/);
    assert.equal(r.error.permissionDenied, false);
  }, { FAKEBIN_EXIT: '1' });
});

test('fakebin: denial-shaped stderr maps permissionDenied per adapter', async () => {
  await withFakebin(async () => {
    for (const adapter of [devin, claude, codex, opencode, ori]) {
      const r = await adapter.spawnAgent(spec());
      assert.equal(r.ok, false, adapter.name);
      assert.equal(r.error.permissionDenied, true, adapter.name);
    }
  }, { FAKEBIN_DENY: '1' });
});

test('fakebin: sleep past spec.timeout classifies timedOut', async () => {
  await withFakebin(async () => {
    const r = await devin.spawnAgent(spec({ timeout: 50 }));
    assert.equal(r.ok, false);
    assert.equal(r.error.timedOut, true);
  }, { FAKEBIN_SLEEP: '5000' });
});

test('fakebin via-ori: codex wrap routes model through ori, strips -m', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-via-'));
  try {
    const argvFile = join(dir, 'argv.txt');
    await withFakebin(async () => {
      const r = await codex.spawnAgent(spec({ via: 'ori', model: 'x-ai/grok-4-fast' }));
      assert.equal(r.ok, true, JSON.stringify(r.error));
      assert.equal(r.result.text, 'PONG');
    }, { FAKEBIN_ARGV_FILE: argvFile });
    const seen = readFileSync(argvFile, 'utf8');
    // Regression net for the codex custom-spawnAgent applyVia bypass: the ori
    // stub must receive `codex --model <slug> exec` with no native -m left.
    assert.match(seen, /^codex --model x-ai\/grok-4-fast exec/m);
    assert.ok(!seen.includes(' -m '), seen);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fakebin via-ori: devin has no ori launcher — clean error, no spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-via-'));
  try {
    const argvFile = join(dir, 'argv.txt');
    await withFakebin(async () => {
      const r = await devin.spawnAgent(spec({ via: 'ori' }));
      assert.equal(r.ok, false);
      assert.match(r.error.message, /no 'ori devin' launcher/);
    }, { FAKEBIN_ARGV_FILE: argvFile });
    assert.throws(() => readFileSync(argvFile, 'utf8'), /ENOENT/); // nothing spawned
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fakebin e2e: runScript on real devin adapter journals settled calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-e2e-'));
  try {
    const scriptPath = join(dir, 'w.mjs');
    writeFileSync(scriptPath, `const r = await parallel([0,1].map(i => () => agent('p'+i, {label:'w'+i})));
log('RESULT:' + JSON.stringify(r.map(x => x && x.text)));`);
    const lines = [];
    await withFakebin(async () => {
      const res = await runScript({
        scriptPath, adapter: devin, cwd: dir, concurrency: 2,
        err: (s) => lines.push(s),
      });
      assert.equal(res.code, 0);
    });
    const out = JSON.parse(lines.find((l) => l.includes('RESULT:')).split('RESULT:')[1]);
    assert.deepEqual(out, ['PONG', 'PONG']);
    const loaded = Journal.load(Journal.pathFor(dir, Journal.list(dir)[0].runId));
    assert.equal(loaded.settled.size, 2);
    assert.equal(loaded.ended.reason, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
