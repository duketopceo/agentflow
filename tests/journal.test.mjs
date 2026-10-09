import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Journal, listRuns, runsDir, specHash } from "../src/journal.mjs";
import { tmpDir } from "./helpers.mjs";

const spec = { prompt: "hello", cwd: "/tmp", timeout: 1000 };
const spec2 = { prompt: "different", cwd: "/tmp", timeout: 1000 };

test("specHash is stable and sensitive to spec changes", () => {
  assert.equal(specHash(spec), specHash({ ...spec }));
  assert.notEqual(specHash(spec), specHash(spec2));
  // Option order doesn't matter.
  assert.equal(specHash({ a: 1, prompt: "x" }), specHash({ prompt: "x", a: 1 }));
});

test("append + lookup round-trip on matching spec", () => {
  const j = new Journal(join(tmpDir(), "run.jsonl"));
  j.append({ seq: 0, specHash: specHash(spec), ok: true, result: { text: "hi" }, ts: "t" });
  const hit = j.lookup(0, spec);
  assert.equal(hit.hit, true);
  assert.equal(hit.entry.result.text, "hi");
});

test("failed entries do not replay — lookup reports failed so resume retries", () => {
  const j = new Journal(join(tmpDir(), "run.jsonl"));
  j.append({ seq: 0, specHash: specHash(spec), ok: false, result: null, ts: "t" });
  const r = j.lookup(0, spec);
  assert.equal(r.hit, false);
  assert.equal(r.failed, true);
});

test("lookup returns mismatch when spec changed", () => {
  const j = new Journal(join(tmpDir(), "run.jsonl"));
  j.append({ seq: 0, specHash: specHash(spec), ok: true, result: { text: "hi" }, ts: "t" });
  const r = j.lookup(0, spec2);
  assert.equal(r.hit, false);
  assert.equal(r.mismatch, true);
});

test("journal survives reload (resume reads prior file)", () => {
  const dir = tmpDir();
  const p = join(dir, "run.jsonl");
  const j1 = new Journal(p);
  j1.append({ seq: 0, specHash: specHash(spec), ok: true, result: { text: "hi" }, ts: "t" });
  const j2 = new Journal(p);
  assert.equal(j2.lookup(0, spec).hit, true);
});

test("corrupt tail lines are skipped", () => {
  const dir = tmpDir();
  const p = join(dir, "run.jsonl");
  const j1 = new Journal(p);
  j1.append({ seq: 0, specHash: specHash(spec), ok: true, result: { text: "hi" }, ts: "t" });
  appendFileSync(p, '{"seq":1,"broken\n'); // torn write
  const j2 = new Journal(p);
  assert.equal(j2.settled.size, 1);
});

test("first append writes a .gitignore stub under .agentflow/", () => {
  const dir = tmpDir();
  const j = new Journal(join(runsDir(dir), "run.jsonl"));
  j.append({ seq: 0, specHash: specHash(spec), ok: true, result: { text: "hi" }, ts: "t" });
  assert.equal(readFileSync(join(dir, ".agentflow", ".gitignore"), "utf8"), "*\n");
});

test("listRuns summarizes journals newest-first", () => {
  const dir = tmpDir();
  const p = join(runsDir(dir), "run-1.jsonl");
  const j = new Journal(p);
  j.append({ seq: 0, specHash: specHash(spec), ok: true, result: { text: "a" }, ts: "t1" });
  j.append({ seq: 1, specHash: specHash(spec2), ok: false, result: null, ts: "t2" });
  const runs = listRuns(dir);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].calls, 2);
  assert.equal(runs[0].ok, 1);
  assert.equal(runs[0].failed, 1);
});
