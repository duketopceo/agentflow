import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.mjs';

test('journal records run-start, settled calls, run-end; load replays by index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-j-'));
  try {
    const j = Journal.create(dir, { runId: 'r1', script: 's.mjs', harness: 'echo' });
    assert.equal(j.path, Journal.pathFor(dir, 'r1'));
    j.append({ type: 'agent', i: 0, label: 'a', ok: true, result: { text: 'hello', json: null } });
    j.append({ type: 'agent', i: 1, label: 'b', ok: false, error: { message: 'boom' } });
    j.append({ type: 'run-end', reason: 'ok' });

    const loaded = Journal.load(j.path);
    assert.equal(loaded.runStart.runId, 'r1');
    assert.equal(loaded.settled.size, 2);
    assert.equal(loaded.settled.get(0).result.text, 'hello');
    assert.equal(loaded.settled.get(1).ok, false);
    assert.equal(loaded.ended.reason, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Journal.list summarizes runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-j-'));
  try {
    const j = Journal.create(dir, { runId: 'rx', script: 'demo.mjs', harness: 'devin' });
    j.append({ type: 'agent', i: 0, ok: true, result: { text: 'x' } });
    const runs = Journal.list(dir);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, 'rx');
    assert.equal(runs[0].settled, 1);
    assert.equal(runs[0].ended, 'incomplete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load tolerates corrupt lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-j-'));
  try {
    const p = Journal.pathFor(dir, 'bad');
    const j = Journal.create(dir, { runId: 'bad', script: 's.mjs', harness: 'echo' });
    writeFileSync(j.path, '{"type":"agent","i":0,"ok":true,"result":{"text":"t"}}\nNOT-JSON\n', { flag: 'a' });
    const loaded = Journal.load(p);
    assert.equal(loaded.settled.size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
