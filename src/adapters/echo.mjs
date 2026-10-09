// Echo adapter: deterministic canned responses for tests and examples.
// No subprocess, no model spend. Records specs on `specs` for assertions.

export const name = "echo";

export const specs = [];

export async function spawnAgent(spec) {
  specs.push({ ...spec });
  const text = `[echo] ${spec.prompt}`;
  const result = { text, exitCode: 0, stderrTail: "" };
  if (spec.schema) result.json = { echo: true, prompt: spec.prompt };
  return result;
}

export async function probe() {
  return { ok: true, version: "builtin" };
}
