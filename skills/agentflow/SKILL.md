---
name: agentflow
description: Write and run cross-harness dynamic workflow scripts — fan out parallel one-shot agent sessions (devin, claude, codex, opencode) under a bounded pool with journaled, resumable results. Use when a task needs multiple independent agent calls, parallel audits, or rerunnable orchestration.
---

# agentflow

Write a `.mjs` workflow script, run it with the `agentflow` CLI. The script is the orchestration state: intermediate results live in variables, so only the returned value re-enters your context.

## When to use

- Parallel fan-out: audits, research angles, multi-file refactors, N independent subtasks.
- Rerunnable pipelines: a saved script + journal beats re-planning in-context.
- Long fan-out jobs you may need to interrupt and resume.

Don't use it for a single agent call — just run the harness CLI directly.

## Setup

```bash
# from the agentflow repo checkout:
agentflow doctor   # verifies node >= 20 and each harness CLI + flags
agentflow run examples/parallel-audit.mjs --harness echo   # dry-run path
```

If `agentflow` isn't on PATH, invoke `<repo>/bin/agentflow` directly.

## Script API

Globals injected into every script (top-level `await` allowed):

```js
export const meta = { name: "my-flow", description: "..." };  // optional — run banner label + in-script `meta` global (inline object literal only)

const r  = await agent(prompt, opts?);   // → { text, json? } | null  (null = call failed or not started on interrupt)
const rs = await parallel([() => agent(p1), () => agent(p2)]);  // order + null slots preserved
const xs = await pipeline(items, async item => ...);            // sequential map
phase("name"); log("msg");               // progress on stderr
args                                     // array of args after `--`
live                                     // true when run with --live (opt-in gate for spend)
```

`agent()` options (unknown options warn, don't fail):

| option | effect |
| --- | --- |
| `label` | shown in settle lines + journal |
| `model` | model override passed to the harness |
| `schema` | JSON Schema → `result.json` (native where supported, extraction otherwise) |
| `worktree` | `true` = scratch git worktree (snapshots committed HEAD; edits discarded on settle; non-git dirs warn + fall back to cwd); string = caller-managed path |
| `cwd` | working directory (default: run dir) |
| `timeout` | ms before SIGTERM→SIGKILL (default 300000) |
| `permission` | `"default"` (least privilege) or `"escalated"` — clamped by run ceiling |
| `sandbox` | devin: pass `--sandbox` |

No static `import` inside scripts — use `await import("node:fs")` etc.

## Run

```bash
agentflow run flow.mjs --harness devin --concurrency 8 --dir . -- arg1 arg2
agentflow run flow.mjs --resume run-2026-10-08T12-00-00   # replay settled calls
agentflow list       # recorded runs under .agentflow/runs/
agentflow doctor     # harness probes
```

`--dir` sets the journal root — pass the same value to `agentflow list --dir` and `--resume` to find the run again; `--run-id <id>` names a run for scripted resume. Exit codes: 0 done, 1 workflow error (settled calls still journaled — resumable), 130 interrupted (resumable). Scripts can spend real money only behind `--live` (the `live` global gates opt-in paths like the devin smoke).

Harness choice: default from `agentflow.json` or `devin`. Use `--harness echo` to test orchestration with zero model spend.

## Writing good workflows

- Check every result for `null` before using it — failed calls don't throw. Interrupt-time nulls (call never started) and failure nulls both re-execute on resume; only settled successes replay.
- Keep prompts self-contained: the leaf agent sees only the prompt + cwd, not your conversation.
- Give parallel calls distinct `label`s so settle lines and journals are readable.
- Use `schema` when downstream code consumes the output; it survives resume.
- `worktree: true` for agents that write files — isolates them from each other.
- Keep `agent()` call order and specs deterministic across resume — replay is keyed on call sequence + a hash of prompt and all options; `Date.now()`/`Math.random()` in prompts or reordered calls force re-execution. An unknown `--resume` id warns and starts fresh — check `agentflow list` first.
- Each `agent()` spawns a full harness CLI session (seconds-scale startup) — fan out at meaningful-task granularity, not micro-tasks; pass `model` for cheap extraction stages. Inside Claude Code, prefer the native Workflow tool. Workflows can nest (a leaf spawning agentflow recurses) — avoid unless intended.

## Safety boundaries

- Scripts run with your full ambient privileges — the wrapper is not a sandbox. Read scripts before running, including agent-generated ones.
- `permission: "escalated"` per call only takes effect if the run ceiling allows (`--permission escalated`).
- Journals under `.agentflow/runs/` persist labels, call-spec hashes (not the prompt text), and full agent output + stderr tails — output may contain secrets; clean up after sensitive runs.
