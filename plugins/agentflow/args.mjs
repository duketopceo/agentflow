// Shared argv builder for the OpenCode plugin's two version arms.
//
// Both the v1 plugin function and the v2 Plugin.define setup assemble the same
// `agentflow` invocation. Assembling it in one pure place keeps the surfaces
// from drifting — duplicated flag handling is how the two arms diverged in the
// first place. This module is plain .mjs so `node --test` can import it
// directly; the .ts entry imports it without a build step.
//
// Flag vocabulary is defined by the runner, not here — see src/cli.mjs
// parseFlags and the `run` command: `run <script> [--harness <name>]
// [--via <name>] [-- <script args>...]`. This function only places that
// vocabulary into the order the runner expects.
//
// The runner emits everything on stderr (verified: stdout is empty), so a
// caller that reads stdout alone gets "" and loses the run-id. Capture is the
// caller's concern — see the version arms in index.ts.

// Build the agentflow argv array for the `run` subcommand from a tool-argument
// object. Optional fields that are absent (or empty) are omitted entirely, so
// the returned argv carries no stray flags or trailing separator.
export function buildRunArgs({ script, harness, via, scriptArgs } = {}) {
  const argv = ['run', script];
  if (harness) argv.push('--harness', harness);
  if (via) argv.push('--via', via);
  if (scriptArgs) argv.push('--', scriptArgs);
  return argv;
}

// Build the argv for `agentflow doctor` (no positional, no flags).
export function buildDoctorArgs() {
  return ['doctor'];
}