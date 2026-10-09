// OpenCode adapter: `opencode run --format json` one-shot sessions.
// Least-privilege default (KTD7): no --auto unless the script escalates.
// Output is an event JSONL stream; result text is the final text part.

import { extractJson } from "../schema.mjs";
import { probeBinary, spawnCli, toResult } from "./base.mjs";

export const name = "opencode";

export function buildArgv(spec) {
  const argv = ["run", "--format", "json"];
  if (spec.model) argv.push("-m", spec.model);
  if (spec.cwd) argv.push("--dir", spec.cwd);
  // KTD7: --auto only on explicit per-call escalation, never by default.
  if (spec.permission === "escalated") argv.push("--auto");
  argv.push(spec.prompt);
  return argv;
}

export function parseEvents(stdout) {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    const ev = extractJson(lines[i]);
    if (!ev || typeof ev !== "object") continue;
    const part = ev.part ?? ev;
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (typeof ev.text === "string") return ev.text;
  }
  return "";
}

export async function spawnAgent(spec) {
  const raw = await spawnCli("opencode", buildArgv(spec), { cwd: spec.cwd, timeoutMs: spec.timeout });
  return toResult(spec, raw, parseEvents(raw.stdout) || raw.stdout.trim());
}

export async function probe() {
  return probeBinary("opencode", ["--version"], ["--format", "--dir", "--auto"], ["run", "--help"]);
}
