import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '../src/pool.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('pool bounds concurrency: 10 tasks at limit 3 never exceed 3 in flight', async () => {
  const pool = new Pool(3);
  let active = 0;
  const peak = { v: 0 };
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      pool.run(async () => {
        active++;
        peak.v = Math.max(peak.v, active);
        await sleep(10);
        active--;
        return i;
      })),
  );
  assert.equal(peak.v, 3);
  assert.equal(pool.maxActive, 3);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('pool preserves order and resolves all queued tasks', async () => {
  const pool = new Pool(2);
  const out = await Promise.all(Array.from({ length: 6 }, (_, i) => pool.run(() => Promise.resolve(i * 10))));
  assert.deepEqual(out, [0, 10, 20, 30, 40, 50]);
});

test('drain resolves queued tasks as null and stops dequeuing', async () => {
  const pool = new Pool(1);
  let ran = 0;
  const slow = pool.run(async () => { ran++; await sleep(50); return 'slow'; });
  const queued = Promise.all([pool.run(() => (ran++, 'q1')), pool.run(() => (ran++, 'q2'))]);
  pool.drain();
  const [a, b] = await queued;
  assert.equal(a, null);
  assert.equal(b, null);
  assert.equal(ran, 1); // only the in-flight task ran
  assert.equal(await slow, 'slow'); // in-flight completes
});

test('run after drain resolves null immediately', async () => {
  const pool = new Pool(2);
  pool.drain();
  assert.equal(await pool.run(() => 'x'), null);
});
