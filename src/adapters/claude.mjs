// Claude adapter: `claude -p --output-format json` one-shot sessions.
// Least-privilege default (KTD7): read-only --allowedTools unless escalated.

import { extractJson } from "../schema.mjs";
import { classifyStderr, probeBinary, spawnCli } from "./base.mjs";

export const name = "claude";

const READONLY_TOOLS = "Read,Glob,Grep,LS";

export function buildArgv(spec, { schemaFile } = {}) {
  const argv = ["-p", spec.prompt, "--output-format", "json"];
  if (spec.model) argv.push("--model", spec.model);
  if (spec.schema) argv.push("--json-schema", schemaFile ?? JSON.stringify(spec.schema));
  // Escalated = omit the allowlist entirely (unrestricted); an empty string
  // would restrict to no tools.
  if (spec.permission !== "escalated") argv.push("--allowedTools", READONLY_TOOLS);
  return argv;
}

// Unwrap the --output-format json envelope: result / structured_output / text.
export function parseEnvelope(stdout) {
  const env = extractJson(stdout);
  const text =
    (env && typeof env === "object" && (env.result ?? env.structured_output ?? env.text)) ??
    stdout.trim();
  return { env, text: typeof text === "string" ? text : JSON.stringify(text) };
}

export async function spawnAgent(spec) {
  const raw = await spawnCli("claude", buildArgv(spec), { cwd: spec.cwd, timeoutMs: spec.timeout });
  const { env, text } = parseEnvelope(raw.stdout);
  const result = {
    text,
    exitCode: raw.code,
    stderrTail: classifyStderr(raw),
  };
  if (spec.schema) result.json = (env && env.structured_output) ?? extractJson(result.text) ?? null;
  return result;
}

export async function probe() {
  return probeBinary("claude", ["--version"], ["--output-format", "--allowedTools", "--json-schema"]);
}
