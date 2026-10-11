// Shared argv builder, tool-facing strings, and process invocation for the
// OpenCode plugin's two version arms.
//
// Both the v1 plugin function and the v2 Plugin.define setup assemble the same
// `agentflow` invocation. Assembling it in one pure place keeps the surfaces
// from drifting — duplicated flag handling is how the two arms diverged in the
// first place. This module is plain .mjs so `node --test` can import it
// directly; the .ts entries import it without a build step.
//
// Flag vocabulary is defined by the runner, not here — see src/cli.mjs
// parseFlags and the `run` command: `run <script> [--harness <name>]
// [--via <name>] [-- <script args>...]`. This module only places that
// vocabulary into the order the runner expects.
//
// `run` writes everything to stderr — stdout is empty (verified). The other
// subcommands (doctor, status, list) write to stdout. Capture both regardless:
// the tool surface should not depend on which stream a given subcommand picks.
import { execFile } from 'node:child_process';

// Tool-facing strings shared by the v1 and v2 arms. The two SDKs disagree on
// schema SHAPE (JSON Schema vs the v1 `tool.schema` Zod helpers) but not on
// wording — and duplicated prose is exactly how the two surfaces drifted before.
export const RUN_DESCRIPTION =
  "Run an agentflow dynamic-workflow script: pooled fresh-context agents across devin/claude/codex/opencode/ori and direct-API adapters (openrouter/perplexity/openai/anthropic). Journals to .agentflow/, resumable.";
export const DOCTOR_DESCRIPTION =
  "Probe installed agent harnesses and flag missing binaries or drifted flags.";
export const HARNESS_DESCRIPTION =
  "devin|claude|codex|opencode|ori|openrouter|perplexity|openai|anthropic|echo";
export const VIA_DESCRIPTION = "ori — route the harness through OpenRouter";
export const SCRIPT_DESCRIPTION = "workflow script path, e.g. workflows/deep-research.mjs";
export const SCRIPT_ARGS_DESCRIPTION = "args after --, e.g. a task or question";

// Build the agentflow argv array for the `run` subcommand from a tool-argument
// object. Optional fields that are absent (or empty) are omitted entirely, so
// the returned argv carries no stray flags or trailing separator.
export function buildRunArgs({ script, harness, via, scriptArgs }) {
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

// Invoke the agentflow CLI and resolve { code, out }.
//
// out is the COMBINED stdout+stderr. The runner emits every operator-relevant
// line — phase markers, per-lane results, the `[agentflow] run <id>` line, and
// script log() output — on stderr, leaving stdout empty. A caller that reads
// stdout alone gets "" and loses the run-id needed to resume or stop. Both
// plugin arms call this so neither can regress into a stdout-only read.
//
// Failure modes that do NOT come from the runner's own exit code are named
// explicitly. Without this they all collapse to "agentflow exited 1", which
// sends an agent looking for a script bug when the real cause is a missing
// binary, a timeout, or truncated output.
const SPAWN_FAILURE = {
  ENOENT: 'agentflow not found on PATH — install it (npm link in the repo) or add bin/ to PATH',
};

export function runAgentflow(argv, { cwd, timeoutMs = 30 * 60_000, bin = 'agentflow' } = {}) {
  return new Promise((resolve) => {
    execFile(bin, argv, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const combined = `${stdout}${stderr}`;
      if (!err) return resolve({ code: 0, out: combined || 'agentflow produced no output' });

      if (err.code === 'ENOENT') return resolve({ code: 127, out: SPAWN_FAILURE.ENOENT });
      if (err.killed) return resolve({ code: 124, out: `${combined}\nagentflow timed out after ${Math.round(timeoutMs / 60000)}m and was terminated` });
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return resolve({ code: 1, out: `${combined}\nagentflow output exceeded 8MB and was truncated — full journal in .agentflow/runs/` });
      }
      // A real nonzero exit: `combined` carries the runner's own stderr reason.
      const code = typeof err.code === 'number' ? err.code : 1;
      resolve({ code, out: combined || `agentflow exited ${code}` });
    });
  });
}