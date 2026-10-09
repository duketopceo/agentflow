import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as claude from "../src/adapters/claude.mjs";
import { spawnCli } from "../src/adapters/base.mjs";
import * as codex from "../src/adapters/codex.mjs";
import * as devin from "../src/adapters/devin.mjs";
import * as opencode from "../src/adapters/opencode.mjs";

const FIX = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const spec = { prompt: "do the thing", cwd: "/tmp", timeout: 1000, permission: "default" };

// --- argv construction (no spawning) ---

test("devin argv: -p, trust flag, permission mode", () => {
  const a = devin.buildArgv(spec);
  assert.deepEqual(a.slice(0, 5), ["-p", "do the thing", "--respect-workspace-trust", "false", "--permission-mode"]);
  assert.equal(a[5], "smart");
});

test("devin argv: escalated → dangerous; model and sandbox flags", () => {
  const a = devin.buildArgv({ ...spec, permission: "escalated", model: "opus", sandbox: true });
  assert.ok(a.includes("dangerous"));
  assert.ok(a.includes("--model") && a.includes("opus"));
  assert.ok(a.includes("--sandbox"));
});

test("claude argv: print, json output, read-only tools by default", () => {
  const a = claude.buildArgv(spec);
  assert.ok(a.includes("-p") && a.includes("--output-format") && a.includes("json"));
  const tools = a[a.indexOf("--allowedTools") + 1];
  assert.equal(tools, "Read,Glob,Grep,LS");
});

test("claude argv: escalated omits the allowlist; schema emits --json-schema", () => {
  const a = claude.buildArgv({ ...spec, permission: "escalated", schema: { type: "object" } });
  assert.ok(!a.includes("--allowedTools"));
  assert.ok(a.includes("--json-schema"));
});

test("codex argv: exec, workspace-write sandbox, -C cwd, --json", () => {
  const a = codex.buildArgv(spec, {});
  assert.equal(a[0], "exec");
  assert.ok(a.includes("-s") && a.includes("workspace-write"));
  assert.ok(a.includes("-C") && a.includes("/tmp"));
  assert.ok(a.includes("--json"));
});

test("codex argv: schema + output file flags", () => {
  const a = codex.buildArgv({ ...spec, schema: { type: "object" } }, { schemaFile: "/tmp/s.json", outFile: "/tmp/o.txt" });
  assert.ok(a.includes("--output-schema") && a.includes("/tmp/s.json"));
  assert.ok(a.includes("-o") && a.includes("/tmp/o.txt"));
});

test("opencode argv: run, json format, dir", () => {
  const a = opencode.buildArgv(spec);
  assert.equal(a[0], "run");
  assert.ok(a.includes("--format") && a.includes("json"));
  assert.ok(a.includes("--dir") && a.includes("/tmp"));
});

test("opencode argv: --auto only on escalation", () => {
  assert.ok(!opencode.buildArgv(spec).includes("--auto"));
  assert.ok(opencode.buildArgv({ ...spec, permission: "escalated" }).includes("--auto"));
});

// --- output parsing from fixtures ---

test("claude parseEnvelope extracts result from --output-format json envelope", () => {
  const stdout = readFileSync(join(FIX, "claude-out.json"), "utf8");
  assert.equal(claude.parseEnvelope(stdout).text, "fixed the bug");
});

test("codex lastMessage takes the last agent message from JSONL", () => {
  const stdout = readFileSync(join(FIX, "codex-events.jsonl"), "utf8");
  assert.equal(codex.lastMessage(stdout), "done: 3 files changed");
});

test("codex lastMessage handles unwrapped item and content-array shapes", () => {
  const stdout = [
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"type":"agent_message","content":[{"type":"text","text":"second"}]}}',
  ].join("\n");
  assert.equal(codex.lastMessage(stdout), "second");
});

test("opencode parseEvents takes the final text part", () => {
  const stdout = readFileSync(join(FIX, "opencode-events.jsonl"), "utf8");
  assert.equal(opencode.parseEvents(stdout), "audit complete");
});

// --- subprocess lifecycle ---

test("timeout kills the subprocess and reports timedOut", async () => {
  const r = await spawnCli("node", ["-e", "setTimeout(()=>{},60000)"], { timeoutMs: 150 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
});

test("missing binary resolves spawnError (never throws)", async () => {
  const r = await spawnCli("agentflow-nonexistent-bin", ["-p", "x"], { timeoutMs: 5000 });
  assert.equal(r.spawnError, true);
  assert.equal(r.code, -1);
});

test("plugin manifests are valid JSON", () => {
  for (const p of ["plugin.json", ".devin-plugin/plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    const j = JSON.parse(readFileSync(join(FIX, "..", "..", p), "utf8"));
    assert.equal(j.name, "agentflow", p);
  }
});
