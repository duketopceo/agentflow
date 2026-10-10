---
title: "M6 — ops parity: --stop, scripted smoke runner, runner worktrees"
status: ready_for_implementation
created: 2026-10-10
origin: "M5–M8 roadmap set (2026-10-10); v0.2 deferrals: stop channel, smoke script, worktree isolation"
---

# M6 — ops parity: `--stop`, scripted smoke runner, runner worktrees

## Problem

`--detach` + `status`/`tail` (#6) shipped the journal-based process surface,
but three deferrals remain: there is no cancellation channel (plan-003
explicitly deferred `--stop`), the v0.2-plan `scripts/smoke-harnesses.mjs`
was never written so the adapter matrix is manual and irreproducible, and
worktree isolation stayed backlog — parallel coding agents all share the
caller cwd, which collides the moment a workflow runs file-mutating stages.

## Scope

### In scope

- `agentflow stop <run-id>` — SIGTERM the journaled pid; runtime's existing
  drain/grace path journals `run-end: interrupted` itself.
- Orphan detection in `status`/`list`: pid dead + no `run-end` → `orphaned`,
  not `running`.
- `scripts/smoke-harnesses.mjs` — matrix-driven live smoke emitting markdown
  rows for `docs/smoke-matrix.md`.
- `worktree: 'auto'` on `agent()` — runner-provisioned git worktree per call,
  journaled; `agentflow clean` reclaims worktrees of ended runs.

### Out of scope

- RPC/daemon anything — file-and-signal only, same as detach.
- Merge-back/collection of worktree contents — the workflow script owns
  deciding what to do with each checkout (a later "collect" primitive).
- `agentflow clean` GC heuristics beyond "run ended" — no age/size policies.
- Provider-side cancellation of in-flight agent calls.

## Requirements

- **R1.** `agentflow stop <run-id>` reaches terminal state on a live run and
  exits 0; refuses to signal a pid whose start-time doesn't match the
  journal's `run-start.at` (pid-reuse guard).
- **R2.** `status`/`list` report `orphaned` when the journaled pid is dead and
  no `run-end` exists, pointing at `--resume`.
- **R3.** The smoke runner reproduces the adapter matrix on demand: per-adapter
  invocation, pass/fail, latency — cheap-first defaults, no premium models.
- **R4.** `agent(p, {worktree:'auto'})` runs the call with `cwd` set to a fresh
  `git worktree` of the containing repo, path journaled per call index.
- **R5.** `agentflow clean` removes journaled worktrees belonging to ended
  runs only — never a live run's checkout.

## Key Technical Decisions

- **KTD1 — signal the journaled pid; no pidfiles.** `run-start` already
  records `pid`. The reuse guard reads the process start-time
  (`/proc/<pid>/stat` on Linux, `ps -o lstart=` fallback) and compares with
  `run-start.at` before SIGTERM — a mismatched pid is someone else's process.
- **KTD2 — worktrees persist past run-end; cleanup is explicit.** A worktree's
  value is the agent's work in it — auto-deleting at run-end could silently
  drop uncollected work. `agentflow clean` is the operator-visible reclaim.
- **KTD3 — `'auto'` is runner-owned; `true` stays adapter-native.** Codex's
  existing `--worktree` mapping is untouched. The runner consumes only the
  literal `'auto'` (converts to `spec.cwd` before the adapter sees it), so a
  codex call never gets both mechanisms.
- **KTD4 — smoke runner emits rows, not doc rewrites.** `smoke-matrix.md`
  stays human-curated; the script's job is reproducible invocation and
  measurement — re-run, paste rows. OR rows inherit `OPENROUTER_API_KEY`
  from the caller env (workspace rule: eval spend routes via the orchestral
  key, never `openrouter/default`).

## Implementation Units

### U1. `agentflow stop` + orphan detection

**Goal:** live runs are stoppable; dead-pid journals read as orphaned.

**Requirements:** R1, R2

**Dependencies:** none

**Files:** `src/cli.mjs`, `tests/cli.test.mjs`, `skills/agentflow/SKILL.md`

**Approach:** `stopCmd` loads the journal — ended → print end reason and exit
0 (already terminal); alive → read `runStart.pid`, liveness-check
(`process.kill(pid, 0)`), compare start-time vs `runStart.at` (refuse on
mismatch), `SIGTERM`, poll the journal until `run-end` or a grace+10s bound.
Exit 0 on reaching terminal, 1 on failure-to-stop, 2 on unknown run-id.
`statusCmd`/`list`: when no `run-end`, check pid liveness — dead →
`orphaned (pid N dead — resume: agentflow run <script> --resume <id>)`,
exit 2. SKILL.md gains stop/orphan/clean rows.

**Test scenarios:**

- Detached echo run (`AGENTFLOW_ECHO_SLOW` large) → `stop` → journal has
  `run-end: interrupted`, child pid gone; exit 0.
- `stop` on an ended run → prints reason, exit 0; unknown id → clean exit 2.
- Orphan: hand-write journal with a dead pid + no run-end → `status` prints
  `orphaned`; `stop` reports nothing-to-kill + `--resume` hint, no signal.
- Pid reuse: journal `runStart.pid` pointed at a live unrelated `sleep`
  process started after `run-start.at` → stop refuses, the process survives.

**Verification:** no zombie `--detach` runs; a crashed child can't be mistaken
for running.

### U2. `scripts/smoke-harnesses.mjs`

**Goal:** the live adapter matrix is one command away and reproducible.

**Requirements:** R3

**Dependencies:** none

**Files:** `scripts/smoke-harnesses.mjs` (new), `docs/smoke-matrix.md` (header
note), `README.md` (one line)

**Approach:** in-file row config `{name, harness, via?, model?, notes}` —
defaults mirror the v0.2 cheap-first matrix (devin `swe-2-medium`, ori +
openrouter + via-ori harnesses on `z-ai/glm-5.3-flash`, echo). Per row: probe
binary first (missing → `FAIL (not on PATH)` row, not a crash), spawn
`bin/agentflow run <script> --harness <h> [--via <v>] -- <model>` (default
script `examples/smoke.mjs`), 120s timeout, capture first-line text +
latency. Output: markdown table rows + `--json` for machine use; `--only
<csv>` filters rows. No secrets handled — env inherited.

**Test scenarios:**

- `--only echo` completes free and prints a PONG row.
- A row whose binary is absent → `FAIL (not on PATH)` row, script continues.
- Non-zero agentflow exit → row records fail + trimmed stderr line.
- `--json` emits a parseable array of `{name, harness, ok, latencyMs, text}`.

**Verification:** one invocation reproduces the 2026-10-09 matrix rows; rows
paste cleanly into `docs/smoke-matrix.md`.

### U3. `worktree: 'auto'` runner worktrees + `agentflow clean`

**Goal:** a call can demand its own checkout; reclaim is explicit.

**Requirements:** R4, R5

**Dependencies:** none

**Files:** `src/runtime.mjs`, `src/journal.mjs`, `src/cli.mjs`,
`tests/runtime.test.mjs`, `tests/cli.test.mjs`, `skills/agentflow/SKILL.md`

**Approach:** inside the pool task (journal-before-slot-release invariant
holds), when `spec.worktree === 'auto'`: resolve repo root via `git -C <cwd>
rev-parse --show-toplevel` (failure → that call settles null with a
`not a git repo` error; run continues); `git worktree add --detach
<repo>/.agentflow/worktrees/<runId>-<i> HEAD`; set `spec.cwd` to the worktree;
drop `spec.worktree` so adapters never see `'auto'`; journal
`{type:'worktree', i, path}` inside the task. `agentflow clean` scans
journals for `worktree` records whose run has `run-end` and
`git worktree remove --force`s them; `--all` also sweeps on-disk
`.agentflow/worktrees/` dirs with no journal record. `.agentflow/` is already
gitignored, so worktrees nest safely inside the main checkout.

**Test scenarios:**

- Git-repo fixture + echo adapter: `worktree:'auto'` → spec.cwd points inside
  `.agentflow/worktrees/`, dir exists post-run, `git -C <path> status` is a
  clean checkout of HEAD.
- Non-git cwd → call returns null with `not a git repo`; run continues.
- `worktree:true` on codex still emits `--worktree` (adapter-native path
  unchanged — fakebin-free argv assertion, no codex needed).
- Interrupted run: worktree dirs persist after `run-end: interrupted`;
  `agentflow clean` removes them (journal ended), leaves a *running* run's
  dirs untouched.
- `clean --all` removes a stray dir with no journal record.

**Verification:** two parallel `worktree:'auto'` calls in one run get distinct
checkouts; `git worktree list` is empty after `clean`.

## Deferred to Follow-Up Work

- `agentflow clean` age/size GC policies; `clean --dry-run`.
- Worktree collection/merge-back primitive for coding workflows.
- `--pause`, remote cancel over RPC — daemon territory, stays out.
- Provider-side cancel of an in-flight agent call (kill is local-only today).
