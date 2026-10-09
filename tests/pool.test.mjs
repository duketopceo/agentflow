import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "../src/pool.mjs";

test("pool never exceeds concurrency limit", async () => {
  const pool = new Pool(3);
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return "x";
  };
  await Promise.all(Array.from({ length: 10 }, () => pool.run(task)));
  assert.equal(maxActive, 3);
});

test("pool is FIFO: tasks start in submission order", async () => {
  const pool = new Pool(1);
  const order = [];
  await Promise.all([0, 1, 2, 3].map((i) => pool.run(async () => order.push(i))));
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test("close() resolves queued-but-unstarted tasks with started:false", async () => {
  const pool = new Pool(1);
  const slow = pool.run(() => new Promise((r) => setTimeout(() => r("slow"), 30)));
  const queued = pool.run(async () => "queued");
  pool.close();
  const q = await queued;
  assert.equal(q.started, false);
  const s = await slow;
  assert.equal(s.started, true);
  assert.equal(s.result, "slow");
});

test("pool maps thrown errors to null results", async () => {
  const pool = new Pool(2);
  const { started, result } = await pool.run(async () => {
    throw new Error("boom");
  });
  assert.equal(started, true);
  assert.equal(result, null);
});

test("run() on a closed pool returns started:false immediately", async () => {
  const pool = new Pool(2);
  pool.close();
  const { started } = await pool.run(async () => "x");
  assert.equal(started, false);
});
