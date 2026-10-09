---
title: Interrupt-safe journaling for pooled subprocess agent runs
date: 2026-10-09
category: agent-orchestration
module: src/runtime.mjs
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - Orchestrating agents as subprocesses under a concurrency pool
  - Any kill/resume lifecycle where settled work must be replayed exactly once
  - Headless CLI fan-out (devin -p, claude -p, codex exec, opencode run)
tags: [agent-orchestration, journaling, resume, signal-handling, concurrency]
---

# Interrupt-safe journaling for pooled subprocess agent runs

## Context

agentflow fans out one-shot harness CLIs (`devin -p`, `claude -p`, `codex exec`,
`opencode run`) under a bounded pool and journals each settled call to JSONL so
`--resume` can replay results and re-execute only unsettled work. Two interrupt
races silently break that contract if journaling happens "after" the task:

1. **Journal-after-release race.** If a task releases its in-flight slot in
   `finally` and the settle continuation journals afterward, a SIGINT drain can
   observe "nothing in flight" and write `run-end` + exit before the finished
   result is appended. Work completes but is never recorded — resume re-runs it.
2. **Abort-masquerading-as-failure.** An in-flight call killed by our own
   `AbortController` returns an ordinary failure shape. If that is journaled as
   a settled failure, resume replays it as a *result* (`null`) instead of
   re-executing the call — the run quietly loses work.

## Guidance

- **Journal inside the pool task, before releasing the slot.** The invariant is
  `inFlight.empty ⇒ durable record`. Any ordering where slot-release precedes
  the append is unsafe under drain.
- **Classify your own abort.** A failure that lands while `abort.signal.aborted`
  is a cancellation, not a settled result — do not journal it. Resume must see
  it as unsettled so it re-executes.
- **Queued-vs-settled is a journal question, not a queue question.** Drained
  queue items resolve `null` without a record; only genuinely-executed calls are
  journaled.
- **Gate normal completion on an in-progress signal handler.** If the script
  finishes while drain is still waiting on grace, the process must still exit
  with the signal code (130/143) and after the `run-end` record — otherwise the
  run reports success with dropped calls.
- **Detect headless permission stalls.** Non-interactive harness sessions that
  hit an approval prompt exit nonzero with recognizable stderr; adapter-supplied
  `permissionDeniedPatterns` regexes keep that distinct from ordinary agent
  failure so operators see "needs `permission: 'escalated'`" rather than "agent
  failed".

## Verified headless flag matrix (2026-10-09, this machine)

| Harness | Spawn | Model | Structured output | Escalation |
|---|---|---|---|---|
| devin | `devin -p <prompt> --respect-workspace-trust false` | `--model` | prompt-level only | `--permission-mode dangerous` |
| claude | `claude -p <prompt> --output-format json` | `--model` | prompt-level (envelope `.result`) | `bypassPermissions` |
| codex | `codex exec <prompt>` | `-m` | `--output-schema <file>` native | `--dangerously-bypass-approvals-and-sandbox` |
| opencode | `opencode run <msg> --format json` | `-m provider/model` | prompt-level (event JSONL) | `--auto` |

Gotchas worth the bytes:

- Devin's `--permission-mode auto` is read-only — too weak for coding agents;
  `smart` is the useful default.
- `devin plugins install` prompts interactively; `-y` is required headless.
- Codex needs `--skip-git-repo-check` outside git dirs and writes the final
  answer via `-o <file>`, not stdout.
- OpenCode `--format json` emits an event stream (JSONL) — the answer is the
  concatenation of text parts, not the last line.
- Private repos on the free GitHub tier cannot receive branch protection via
  API — `gh repo create` hardening silently degrades there.

## Why This Matters

Resume correctness is the difference between "workflow runner" and "script that
re-runs everything." The failure modes above are invisible in happy-path tests —
they only appear under interrupt — and each one silently converts real agent
work into either duplicated cost or permanently lost results.

## When to Apply

- Any orchestrator spawning processes with a kill/resume lifecycle.
- Any wrapper that translates a harness's approval model into headless calls.

## Examples

See `src/runtime.mjs` (task-local journaling, abort classification, signal gate)
and `tests/runtime.test.mjs` (`SIGINT: queued calls never start...`) for the
test that pins the invariant.

## Related

- `docs/plans/2026-10-08-001-feat-agentflow-dynamic-workflows-plan.md`
