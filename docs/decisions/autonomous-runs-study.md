# Autonomous-runs study: Symphony spec + AX vocabulary → agentflow

Date: 2026-10-19. Plan: `docs/plans/2026-10-19-002-eval-autonomous-runs-symphony-ax-plan.md`.
Status: decided (analysis artifact — no code changes).

## Sources (primary)

- `openai/symphony` — `SPEC.md` on `main` (fetched 2026-10-19), "Symphony Service
  Specification, Draft v1 (language-agnostic)". The Elixir implementation is
  treated as an optional reference per the plan; findings below cite the spec,
  not the code.
- `google/ax` — `docs/concepts.md`, `docs/manifests.md`, `README.md` on `main`
  (fetched 2026-10-19). The K8s/Substrate substrate is out of scope per plan;
  only manifest semantics and lifecycle vocabulary are considered.
- agentflow — `src/journal.mjs`, `src/runtime.mjs`, `src/cli.mjs` at this
  branch; `DESIGN.md`, `ROADMAP.md`, `docs/research/2026-10-10-landscape.md`.

## 1. Symphony's completion contract, quoted precisely

The plan brief described Symphony's output as a "proof-of-work bundle (CI
status, PR review feedback, walkthrough videos)". That is the README/marketing
framing. The **spec itself defines completion more subtly — as a handoff
state plus reconciliation**, not a fixed artifact bundle:

- §1: *"A successful run can end at a workflow-defined handoff state (for
  example `Human Review`), not necessarily `Done`."*
- §11.5: *"Workflow-specific success often means 'reached the next handoff
  state' (for example `Human Review`) rather than tracker terminal state
  `Done`."*
- §7.1: *"A successful worker exit does not mean the issue is done forever."*

Mechanically the spec separates three things agentflow currently conflates
into "settled":

1. **Worker exit** (the agent process finished, normally or not),
2. **Workflow-defined success** (the issue reached a declared handoff state —
   judged by re-reading the tracker, not by the exit code), and
3. **Evidence location** — the proof artifacts (PR, CI status, comments) are
   written by *the coding agent itself* via provider-native tools: §11.5,
   *"Ticket mutations (state transitions, comments, attachments, PR metadata)
   are typically handled by the coding agent through the selected adapter's
   provider-native tools."* The orchestrator never sees or validates the
   proof; it re-reads the work source.

So "proof-of-work" in the spec = *the work source says the handoff happened*,
re-verified by the orchestrator on every poll tick (§8.5 reconciliation stops
runs whose issue left an active state). There is no proof schema; there is a
re-check loop.

## 2. AX manifest model, condensed

`ax.io/v1alpha1`, four kinds, multi-doc YAML:

- **Task** — smallest unit of isolated execution. `spec.image` must be
  digest-pinned (*"a tag can move and would silently invalidate the actor's
  snapshots"*), `resources.limits` only (no requests), at most one `Workspace`
  binding, `spec.config` = arbitrary ≤16 KiB YAML handed to the runner
  verbatim, whole spec immutable once created. `spec.debug: true` is the
  opt-in that makes `ax ssh` work.
- **Workspace** — declarative environment materialized once, bindable by many
  tasks: git repos cloned at revision, literal `files`, MCP
  registries/servers, skill registries + materialization path.
- **Model** — provider + model id + parameters + `secretKey` reference, as a
  cluster resource so rotation/pinning is one `ax apply`.
- **Lifecycle** — `ax suspend` / `ax resume` = *"checkpoint actor state and
  pause"* / *"pick up where it left off"* (Substrate actor snapshots; this is
  why images must be digest-pinned). `status.phase` + conditions
  (`WorkspaceReady`, `Ready`/`Suspended`). `ax ssh` for live inspection.
- AX explicitly refuses to model agent fan-out: *"An agent is not one process
  that runs to completion... AX does not try to model that shape"* — the Task
  is the tree node, the agent composes them.

## 3. Primitive diff and verdicts

| Primitive | Symphony | AX | agentflow today | Verdict |
|---|---|---|---|---|
| Work source | board poll (Linear) + reconciliation | manifest apply | workflow script invoked by user/agent; journal + Hey posts | **Reject** polling; **note** claim state machine |
| Unit | isolated per-issue workspace + worker turns | immutable Task actor | settled `agent()` call in a run; `worktree:'auto'` | **Adapt** — hooks, not actors |
| Completion | handoff state re-verified against tracker | task `status.phase`/conditions | settled journal line (exit/result only) | **Adopt** — declared completion evidence |
| Environment | `WORKFLOW.md` hooks (`after_create`/`before_run`/`after_run`/`before_remove`) | Workspace manifest (git+files+MCP+skills) | `worktree:'auto'` checkout, no setup hooks | **Adapt** — run-scoped setup hooks |
| Model config | `codex.*` config in WORKFLOW.md | `Model` resource + `secretKey` | `--model`/`--via` flags + keyring | **Reject** — already covered |
| Supervision | none — spec: manage work, not agents | `watch`/`ssh`/`suspend`/`resume` | `tail`/`watch`/`status`/`stop`, journal-replay resume | **Reject** ssh/suspend; keep replay-resume |
| Release model | spec-first, impl optional | CRDs + controller | journal format implicit in code | **Adapt** — version the journal schema |

### Rationale per row

**Work source — reject the poll loop, keep the state machine in the pocket.**
Symphony's Unclaimed→Claimed→Running→RetryQueued→Released machine (§7.1)
exists to dedupe dispatches against a mutable external board. agentflow has no
board; a run starts because someone exec'd it. If a Kurultai-Hey-style board
integration ever lands, this is the right model to copy — file it, don't
build it.

**Unit — adapt.** AX's immutable-Task-actor is fleet machinery. But
Symphony's insight that a unit of work deserves *lifecycle hooks around a
persistent workspace* maps directly onto `worktree:'auto'`, which today
provisions `.agentflow/worktrees/<name>` and nothing else. A `before_run`
hook (install deps, materialize fixtures) is the piece both systems
independently arrived at and we lack.

**Completion — adopt.** This is the load-bearing finding, detailed in §4.

**Environment — adapt.** AX's `Workspace` manifest is a per-worktree
environment spec. agentflow's workflow `.mjs` already *is* a repo-owned
executable contract (Symphony's `WORKFLOW.md` with `meta` front matter, but
Turing-complete). The missing delta is declarative setup, not a new manifest
format: hooks, or at most a `workspace` option on `agent()` that names a
provision script.

**Model — reject.** `Model` as a resource solves rotation across a fleet;
agentflow's `model`/`via` per-call options plus keyring cover it on one box.

**Supervision — reject, with the interesting nuance.** `ax suspend/resume`
is process checkpointing — real value on a fleet where a suspended sandbox
frees a VM. On one laptop, a suspended worker frees ~nothing (memory
pressure is the only win, and `SIGSTOP` exists). agentflow's journal-replay
`--resume` is the *better* single-box primitive: deterministic, cheap,
survives reboots, and U3's stale-result guard makes it safe. Borrow nothing
here except the vocabulary (`Suspended` as a phase name if runs ever get
phases).

**Release model — adapt.** Symphony shipped SPEC.md as the product with an
optional reference impl. agentflow's journal is already a de-facto spec
(`src/journal.mjs` documents record types in comments) consumed by `tail`,
`watch`, `status`, `--resume`. It deserves a `type: 'run-start'` schema
version field so external consumers can feature-detect — cheap insurance
before the journal grows proof records (below).

## 4. If we borrow one thing

**Declared completion evidence on the settled record.** Today a run is "done"
when the last `agent()` call settles and `run-end` is appended — the journal
records *that* the process exited, nothing about whether the work landed.
Symphony's actual mechanism (re-check the work source) doesn't port — our
work source is the caller — but its *contract shape* does: let a workflow
declare what counts as done, and let the runner evaluate and journal it.

Concrete change candidate, smallest version: `agent()` accepts
`proof: { tests?, diff?, command? }` — after settle, the runner evaluates the
declared check (e.g. `command` exits 0, `diff` non-empty in the worktree) and
records the outcome on the settled line and aggregates into `run-end`. A run
then reports `ok` vs `ok-unproven` instead of conflating exit status with
task status. This is exactly Symphony's *"successful worker exit does not
mean the issue is done"* enforced at the point agentflow can actually see.

Secondary candidates (named, not committed):

1. `before_run`/`after_run` hooks for `worktree:'auto'` workspaces (Symphony
   §9.4 / AX Workspace, lite).
2. A `journal` schema version field in `run-start` (Symphony's spec-first
   release pattern, applied to our one real interface per DESIGN.md).
3. A `Suspended`-style phase vocabulary if/when U12 (terminal progress view)
   lands — vocabulary only, no checkpointing.

## 5. Non-goals confirmed

- No K8s/Substrate/actor runtimes — laptop tool.
- No board poller/daemon — revisit only if Hey-board dispatch becomes real.
- No `ssh`-into-worker or process checkpoint — `tail`/`watch` and
  journal-replay resume already win on one box.
