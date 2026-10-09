import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.mjs";
import { tmpDir } from "./helpers.mjs";

function script(source) {
  const dir = tmpDir("af-cli-");
  const p = join(dir, "s.mjs");
  writeFileSync(p, source);
  return { dir, p };
}

async function capture(fn) {
  const out = [];
  const err = [];
  const wo = process.stdout.write;
  const we = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  try {
    return { code: await fn(), stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = wo;
    process.stderr.write = we;
  }
}

test("no args prints usage and exits 0", async () => {
  const r = await capture(() => main([]));
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Usage:"));
});

test("unknown command exits 1", async () => {
  const r = await capture(() => main(["frobnicate"]));
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("unknown command: frobnicate"));
});

test("run without a script path exits 1", async () => {
  const r = await capture(() => main(["run"]));
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("run requires a script path"));
});

test("--concurrency banana exits 1 instead of silently clamping", async () => {
  const { dir, p } = script("return 1;");
  const r = await capture(() => main(["run", p, "--harness", "echo", "--dir", dir, "--concurrency", "banana"]));
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("invalid concurrency: banana"));
});

test("unknown permission ceiling exits 1", async () => {
  const { dir, p } = script("return 1;");
  const r = await capture(() => main(["run", p, "--harness", "echo", "--dir", dir, "--permission", "yolo"]));
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("unknown permission ceiling: yolo"));
});

test("unknown harness exits 1", async () => {
  const { dir, p } = script("return 1;");
  const r = await capture(() => main(["run", p, "--harness", "gpt9000", "--dir", dir]));
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("unknown harness: gpt9000"));
});

test("unknown flag warns but does not fail the run", async () => {
  const { dir, p } = script("return (await agent('hi')).text;");
  const r = await capture(() => main(["run", p, "--harness", "echo", "--dir", dir, "--bogus"]));
  assert.equal(r.code, 0);
  assert.ok(r.stderr.includes("warn: unknown flag --bogus ignored"));
  assert.ok(r.stdout.includes("[echo] hi"));
});

test("--live=false parses false; --live parses true into the script global", async () => {
  const { dir, p } = script("return live;");
  const off = await capture(() => main(["run", p, "--harness", "echo", "--dir", dir, "--live=false"]));
  assert.equal(off.code, 0);
  assert.ok(off.stdout.includes("result: false"));
  const on = await capture(() => main(["run", p, "--harness", "echo", "--dir", dir, "--live"]));
  assert.ok(on.stdout.includes("result: true"));
});

test("--live=banana warns and treats as true", async () => {
  const { dir, p } = script("return live;");
  const r = await capture(() => main(["run", p, "--harness", "echo", "--dir", dir, "--live=banana"]));
  assert.equal(r.code, 0);
  assert.ok(r.stderr.includes("--live expects true|false"));
  assert.ok(r.stdout.includes("result: true"));
});

test("-- separator passes trailing args to the script", async () => {
  const { dir, p } = script("return args;");
  const r = await capture(() => main(["run", p, "--harness", "echo", "--dir", dir, "--", "one", "--two"]));
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('"one"') && r.stdout.includes('"--two"'));
});

test("missing value flag warns and falls back to config default", async () => {
  const { dir, p } = script("return (await agent('hi')).text;");
  // --harness with no following value warns; falls back to config/devin... use --dir instead:
  const r = await capture(() => main(["run", p, "--harness", "echo", "--dir", dir, "--concurrency"]));
  assert.equal(r.code, 0);
  assert.ok(r.stderr.includes("warn: --concurrency needs a value"));
});

test("script failure exits 1 with the error message", async () => {
  const { dir, p } = script("throw new Error('boom');");
  const r = await capture(() => main(["run", p, "--harness", "echo", "--dir", dir]));
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("boom"));
});
