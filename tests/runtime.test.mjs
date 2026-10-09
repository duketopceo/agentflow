import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { extractMeta, runScript, WorkflowRuntime } from "../src/runtime.mjs";
import * as echo from "../src/adapters/echo.mjs";
import { gitRepo, tmpDir } from "./helpers.mjs";

function scriptDir(name, source) {
  const dir = tmpDir("af-run-");
  const p = join(dir, `${name}.mjs`);
  writeFileSync(p, source);
  return { dir, p };
}

function rt(dir, extra = {}) {
  return { dir, adapter: echo, concurrency: 8, ...extra };
}

async function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    return { result: await fn(), lines };
  } finally {
    process.stderr.write = orig;
  }
}

test("five echo agents complete; results preserve order", async () => {
  const { dir, p } = scriptDir("s", `
    const results = await parallel([0,1,2,3,4].map(i => () => agent("prompt-" + i)));
    log("done " + results.length);
    return results.map(r => r.text);
  `);
  const { result } = await runScript(p, rt(dir));
  assert.deepEqual(result, [0, 1, 2, 3, 4].map((i) => `[echo] prompt-${i}`));
});

test("failed calls return null; parallel() preserves slots", async () => {
  const failing = { spawnAgent: async () => null, name: "fail" };
  const { dir, p } = scriptDir("s", `
    return await parallel([() => agent("a"), () => agent("b")]);
  `);
  const { result } = await runScript(p, { ...rt(dir), adapter: failing });
  assert.deepEqual(result, [null, null]);
});

test("agent() never throws: null opts normalize; unserializable schema -> null", async () => {
  const { dir, p } = scriptDir("s", `
    const a = await agent("x", null);
    const b = await agent("y", { schema: { f: 10n } });
    return [a?.text ?? null, b];
  `);
  const { result } = await runScript(p, rt(dir));
  assert.deepEqual(result, ["[echo] x", null]);
});

test("resume replays settled calls without respawning", async () => {
  const { dir, p } = scriptDir("s", `
    const a = await agent("first");
    if (!a) throw new Error("fail run 1");
    return a.text;
  `);
  const opts = rt(dir, { runId: "resumable" });
  echo.specs.length = 0;
  const r1 = await runScript(p, opts);
  assert.equal(r1.result, "[echo] first");
  assert.equal(echo.specs.length, 1);

  // Resume: settled seq 0 replays from journal — no new spawn.
  echo.specs.length = 0;
  const r2 = await runScript(p, { ...rt(dir), resumeId: "resumable" });
  assert.equal(r2.result, "[echo] first");
  assert.equal(echo.specs.length, 0);
});

test("run-id collision without --resume re-executes and warns", async () => {
  const { dir, p } = scriptDir("s", `return (await agent("a")).text;`);
  await runScript(p, rt(dir, { runId: "dup" }));
  echo.specs.length = 0;
  const { result, lines } = await captureStderr(() => runScript(p, rt(dir, { runId: "dup" })));
  assert.equal(result.result, "[echo] a");
  assert.equal(echo.specs.length, 1); // re-executed, not replayed
  assert.ok(lines.some((l) => l.includes("already has a journal")));
});

test("unknown --resume id warns and starts fresh", async () => {
  const { dir, p } = scriptDir("s", `return (await agent("a")).text;`);
  const { lines } = await captureStderr(() => runScript(p, rt(dir, { resumeId: "never-ran" })));
  assert.ok(lines.some((l) => l.includes("names no recorded run")));
});

test("resume re-executes a failed call instead of replaying null", async () => {
  const { dir, p } = scriptDir("s", `return (await agent("a"))?.text ?? "null";`);
  const failing = {
    name: "fail",
    spawnAgent: async () => ({ text: "", exitCode: 1, stderrTail: "boom" }),
    probe: async () => ({ ok: true }),
  };
  const r1 = await runScript(p, { ...rt(dir, { runId: "flaky" }), adapter: failing });
  assert.equal(r1.result, "null"); // journaled ok:false
  echo.specs.length = 0;
  const r2 = await runScript(p, { ...rt(dir), resumeId: "flaky" });
  assert.equal(r2.result, "[echo] a"); // retried, not replayed as null
  assert.equal(echo.specs.length, 1);
});

test("journal spec-hash mismatch re-executes instead of replaying", async () => {
  const { dir, p } = scriptDir("s", `return (await agent("v1")).text;`);
  const opts = rt(dir, { runId: "mutate" });
  await runScript(p, opts);
  writeFileSync(p, `return (await agent("v2")).text;`);
  echo.specs.length = 0;
  const r2 = await runScript(p, { ...rt(dir), resumeId: "mutate" });
  assert.equal(r2.result, "[echo] v2");
  assert.equal(echo.specs.length, 1); // respawned, not replayed
});

test("syntax error surfaces a clean failure naming the script", async () => {
  const { dir, p } = scriptDir("bad", `const = ;`);
  await assert.rejects(() => runScript(p, rt(dir)), /bad\.mjs/);
});

test("unknown agent() options warn but don't fail", async () => {
  const { dir, p } = scriptDir("s", `return (await agent("x", { bogus: true })).text;`);
  const { result } = await runScript(p, rt(dir));
  assert.equal(result, "[echo] x");
});

test("meta export is extracted and stripped", async () => {
  const { meta, source } = extractMeta(`export const meta = { name: "w" };
const x = 1;`);
  assert.equal(meta.name, "w");
  assert.ok(!source.includes("export"));
});

test("escalated permission clamps to run ceiling", async () => {
  const { dir, p } = scriptDir("s", `return (await agent("x", { permission: "escalated" })).text;`);
  echo.specs.length = 0;
  await runScript(p, rt(dir, { permission: "default" }));
  assert.equal(echo.specs[0].permission, "default");
});

test("pipeline maps sequentially", async () => {
  const { dir, p } = scriptDir("s", `return await pipeline([1,2,3], async (n) => (await agent("p" + n)).text);`);
  const { result } = await runScript(p, rt(dir));
  assert.deepEqual(result, ["[echo] p1", "[echo] p2", "[echo] p3"]);
});

test("worktree:true runs in a managed scratch worktree removed on settle", async () => {
  const repo = gitRepo();
  const p = join(repo, "s.mjs");
  writeFileSync(p, `return (await agent("x", { worktree: true })).text;`);
  echo.specs.length = 0;
  const { result } = await runScript(p, rt(repo, { runId: "wt-run" }));
  assert.equal(result, "[echo] x");
  const wt = echo.specs[0].cwd;
  assert.ok(wt.includes(join(".agentflow", "wt", "wt-run", "a0")));
  assert.equal(existsSync(wt), false); // removed on settle
});

test("worktree:true outside a git repo warns and falls back to cwd", async () => {
  const { dir, p } = scriptDir("s", `return (await agent("x", { worktree: true })).text;`);
  echo.specs.length = 0;
  const { result, lines } = await captureStderr(() => runScript(p, rt(dir)));
  assert.equal(result.result, "[echo] x");
  assert.equal(echo.specs[0].cwd, dir);
  assert.ok(lines.some((l) => l.includes("falling back to cwd")));
});

test("worktree as a string path is caller-managed and never removed", async () => {
  const repo = gitRepo();
  const sub = join(repo, "sub");
  mkdirSync(sub);
  const p = join(repo, "s.mjs");
  writeFileSync(p, `return (await agent("x", { worktree: "sub" })).text;`);
  echo.specs.length = 0;
  const { result } = await runScript(p, rt(repo));
  assert.equal(result, "[echo] x");
  assert.equal(echo.specs[0].cwd, sub);
  assert.equal(existsSync(sub), true); // caller-managed path survives settle
});

test("agent() on a closed pool returns null and is not journaled", async () => {
  const dir = tmpDir();
  const runtime = new WorkflowRuntime(rt(dir));
  runtime.close(); // as onSignal does
  const r = await runtime.agent("x");
  assert.equal(r, null);
  assert.equal(runtime.journal.settled.size, 0); // unsettled — resumable
});

test("worktree:true on a closed pool creates no worktree", async () => {
  const repo = gitRepo();
  const runtime = new WorkflowRuntime(rt(repo, { runId: "never-spawned" }));
  runtime.close();
  const r = await runtime.agent("x", { worktree: true });
  assert.equal(r, null);
  assert.equal(existsSync(join(repo, ".agentflow", "wt", "never-spawned", "a0")), false);
});

test("invalid timeout falls back to the default with a warn", async () => {
  const dir = tmpDir();
  const runtime = new WorkflowRuntime(rt(dir));
  const { lines } = await captureStderr(async () => {
    const r = await runtime.agent("x", { timeout: 0 });
    assert.equal(r.text, "[echo] x");
  });
  assert.ok(lines.some((l) => l.includes("invalid agent() timeout")));
});

test("invalid run id is rejected before touching the filesystem", () => {
  assert.throws(() => new WorkflowRuntime(rt(tmpDir(), { runId: "../escape" })), /invalid run id/);
  assert.throws(() => new WorkflowRuntime(rt(tmpDir(), { runId: "a/b" })), /invalid run id/);
});

test("non-literal export const meta stays valid script source", () => {
  const { meta, source } = extractMeta(`export const meta = makeMeta();\nreturn 1;`);
  assert.equal(meta, null);
  assert.ok(!source.includes("export")); // `const meta = makeMeta();` survives
  assert.ok(source.includes("const meta = makeMeta();"));
});
