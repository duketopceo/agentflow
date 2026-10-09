// Codex adapter: `codex exec` one-shot sessions.
// Least-privilege default (KTD7): `-s workspace-write`. Result read from the
// -o last-message file. --output-schema needs a temp file, whose lifecycle this
// adapter owns. Worktrees are runner-managed and arrive via spec.cwd (-C) —
// codex exec has no native --worktree flag (verified on 0.152.0).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractJson } from "../schema.mjs";
import { probeBinary, spawnCli, toResult } from "./base.mjs";

export const name = "codex";

export function buildArgv(spec, { schemaFile, outFile } = {}) {
  const argv = ["exec", spec.prompt, "-s", spec.permission === "escalated" ? "danger-full-access" : "workspace-write"];
  if (spec.model) argv.push("-m", spec.model);
  if (spec.schema && schemaFile) argv.push("--output-schema", schemaFile);
  if (outFile) argv.push("-o", outFile);
  if (spec.cwd) argv.push("-C", spec.cwd);
  argv.push("--json");
  return argv;
}

// Last agent message from the --json event stream; tolerates both
// {item:{...}} and {msg:{item:{...}}} event shapes.
export function lastMessage(stdout) {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    const ev = extractJson(lines[i]);
    const item = ev?.msg?.item ?? ev?.item;
    const text = item?.text ?? ev?.msg?.text ?? ev?.text;
    if (typeof text === "string") return text;
    if (Array.isArray(item?.content)) {
      return item.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    }
  }
  return "";
}

export async function spawnAgent(spec) {
  const tmp = mkdtempSync(join(tmpdir(), "agentflow-codex-"));
  const outFile = join(tmp, "last.txt");
  const schemaFile = spec.schema ? join(tmp, "schema.json") : null;
  try {
    if (schemaFile) writeFileSync(schemaFile, JSON.stringify(spec.schema));
    const raw = await spawnCli("codex", buildArgv(spec, { schemaFile, outFile }), {
      cwd: spec.cwd,
      timeoutMs: spec.timeout,
    });
    let text = "";
    try {
      text = readFileSync(outFile, "utf8").trim();
    } catch { /* fall back to stdout event stream */ }
    if (!text) text = lastMessage(raw.stdout);
    return toResult(spec, raw, text, "|sandbox"); // codex surfaces sandbox-policy rejections on stderr
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function probe() {
  return probeBinary("codex", ["--version"], ["--output-schema", "--json"], ["exec", "--help"]);
}
