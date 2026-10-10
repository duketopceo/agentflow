---
title: "agentflow --detach + status/tail — backgrounded runs with journal progress"
status: ready_for_implementation
created: 2026-10-09
origin: "lfg next — biggest remaining Claude-workflow parity gap: runs block the caller (e2e deep-research = 5min)"
---

## Problem

`agentflow run` blocks until completion. Claude's Workflow runs detached with a
journal — the model continues other work and checks back. Our journal already
persists everything needed; the gap is the process lifecycle surface.

## Scope

- `--detach`: spawn `bin/agentflow run <script> <same flags> --run-id <id>` as a
  detached, unref'd child; parent prints `run <id>` + the status command and
  exits 0 immediately. Run-id is generated in the PARENT (so it's known before
  the child boots) and passed via a hidden `--run-id` flag that runScript
  accepts in place of generating one.
- Detached child's stderr/stdout append to `.agentflow/runs/<id>.log`
  (the JSONL journal stays the structured record; the .log keeps raw harness
  output for debugging).
- `agentflow status <run-id>`: reads `.agentflow/runs/<id>.jsonl`; prints
  run-start fields, per-phase progress (calls settled/labels), whether
  run-end exists (reason + code), and last N events. Exits 0 on terminal
  `ok`, 1 on terminal `error`, 2 while running.
- `agentflow tail <run-id>`: streams new journal lines until run-end (poll
  500ms; exits with status's code).
- `agentflow list` exists — extend it to show latest run + state if cheap,
  else leave as-is.

## Non-scope

- No IPC/RPC beyond files; no daemon; no cancellation channel yet
  (kill the child PID by hand; a `--stop` that signals the PID recorded in
  run-start is a reasonable later add — PID journaled in this unit).
- Detach + SIGINT semantics: the detached child still installs its own
  signal handlers; the parent's exit doesn't signal it (detached session).

## Implementation

- `src/cli.mjs`: `--detach` branch before `runScript`; `--run-id` passthrough;
  `status`/`tail` commands.
- `src/runtime.mjs`: accept `opts.runId` (use instead of `Journal.newRunId()`);
  journal `pid` in run-start.
- `src/journal.mjs`: `Journal.summary(path)` → `{runStart, events, runEnd}`-
  shape helper for status/tail reuse.
- `agentflow.example.json` + SKILL.md flags line.

## Tests

- `tests/runtime.test.mjs`: opts.runId honored; status summary shape.
- `tests/cli.test.mjs` (new): spawn `bin/agentflow run --detach` on an echo
  script in tmpdir; assert parent exits fast with run id; poll journal until
  run-end; `status` exits 0; `tail` output contains the phase line.
- Keep the suite's no-subprocess-for-unit-tests convention: the only new
  subprocess is the detached CLI itself (echo adapter — no model calls).
