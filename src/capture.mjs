// Shared argv builders, tool-facing strings, and process invocation for the
// surfaces that wrap the CLI: the OpenCode plugin's two version arms and the
// MCP server (src/mcp.mjs).
//
// Assembling in one pure place keeps the surfaces from drifting — duplicated
// flag handling is how the v1/v2 arms diverged in the first place. This module
// is plain .mjs with zero dependencies so `agentflow mcp` works from a bare
// clone where `npm install` never ran.
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

// Tool-facing strings shared by the plugin arms and the MCP tool list. The
// SDKs disagree on schema SHAPE (JSON Schema vs the v1 `tool.schema` Zod
// helpers) but not on wording — and duplicated prose is exactly how the two
// surfaces drifted before.
export const RUN_DESCRIPTION =
  "Run an agentflow dynamic-workflow script: pooled fresh-context agents across devin/claude/codex/opencode/ori and direct-API adapters (openrouter/perplexity/openai/anthropic). Journals to .agentflow/, resumable.";
export const DOCTOR_DESCRIPTION =
  "Probe installed agent harnesses and flag missing binaries or drifted flags.";
export const STATUS_DESCRIPTION =
  "Read a run's journal: per-lane outcome, token totals, ended state.";
export const TAIL_DESCRIPTION =
  "Stream a run's journal events until it ends (blocks until run-end — prefer agentflow_status for polling).";
export const STOP_DESCRIPTION =
  "SIGTERM a running run's journaled pid and wait for run-end.";
export const HARNESS_DESCRIPTION =
  "devin|claude|codex|opencode|ori|openrouter|perplexity|openai|anthropic|echo";
export const VIA_DESCRIPTION = "ori — route the harness through OpenRouter";
export const SCRIPT_DESCRIPTION = "workflow script path, e.g. workflows/deep-research.mjs";
export const SCRIPT_ARGS_DESCRIPTION = "args after --, e.g. a task or question";
export const RESUME_DESCRIPTION =
  "run-id to resume — replays settled lanes from the journal, executes only missing work";
export const DETACH_DESCRIPTION =
  "return immediately with the run-id instead of blocking (poll with agentflow_status/agentflow_tail)";
export const RUN_ID_DESCRIPTION = "run-id from an earlier agentflow_run (e.g. 2026-10-11T08-30-44-3a3a6aed)";
export const CWD_DESCRIPTION = "working directory for the run (defaults to the MCP server's cwd)";

// Build the agentflow argv array for the `run` subcommand from a tool-argument
// object. Optional fields that are absent (or empty) are omitted entirely, so
// the returned argv carries no stray flags or trailing separator.
export function buildRunArgs({ script, harness, via, scriptArgs, resume, detach }) {
  const argv = ['run', script];
  if (harness) argv.push('--harness', harness);
  if (via) argv.push('--via', via);
  if (resume) argv.push('--resume', resume);
  if (detach) argv.push('--detach');
  if (scriptArgs) argv.push('--', scriptArgs);
  return argv;
}

// Build the argv for `agentflow doctor` (no positional, no flags).
export function buildDoctorArgs() {
  return ['doctor'];
}

// Single-positional verbs: status/tail stream, stop signals the journaled pid.
export const buildStatusArgs = (runId) => ['status', runId];
export const buildTailArgs = (runId) => ['tail', runId];
export const buildStopArgs = (runId) => ['stop', runId];

// Invoke the agentflow CLI and resolve { code, out }.
//
// out is the COMBINED stdout+stderr. The runner emits every operator-relevant
// line — phase markers, per-lane results, the `[agentflow] run <id>` line, and
// script log() output — on stderr, leaving stdout empty. A caller that reads
// stdout alone gets "" and loses the run-id needed to resume or stop. Both
// plugin arms and the MCP server call this so none can regress into a
// stdout-only read.
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

// Shape a runAgentflow result for a v2 tool. Neither SDK exposes an error
// channel inside a tool RESULT — a returned value is recorded as a successful
// call — so a failed run must throw to be seen as one. Shared so both arms
// treat failure identically.
export function toolOutcome(r) {
  if (r.code !== 0) throw new Error(r.out);
  return { content: r.out };
}
