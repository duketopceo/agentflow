// Devin adapter: `devin -p` one-shot sessions (KTD7 default --permission-mode smart).

import { schemaInstruction } from "../schema.mjs";
import { probeBinary, spawnCli, toResult } from "./base.mjs";

export const name = "devin";

const PERMISSION_MAP = { default: "smart", escalated: "dangerous" };

export function buildArgv(spec) {
  const argv = ["-p", spec.prompt, "--respect-workspace-trust", "false", "--permission-mode", PERMISSION_MAP[spec.permission] ?? PERMISSION_MAP.default];
  if (spec.model) argv.push("--model", spec.model);
  if (spec.sandbox) argv.push("--sandbox");
  return argv;
}

export async function spawnAgent(spec) {
  let prompt = spec.prompt;
  if (spec.schema) prompt += `\n\n${schemaInstruction(spec.schema)}`;
  const raw = await spawnCli("devin", buildArgv({ ...spec, prompt }), {
    cwd: spec.cwd,
    timeoutMs: spec.timeout,
  });
  return toResult(spec, raw, raw.stdout.trim());
}

export async function probe() {
  return probeBinary("devin", ["--version"], ["--permission-mode", "--respect-workspace-trust", "--sandbox"]);
}
