---
title: "Chronological parallel build: dependency-aware scheduling, local-time display, and Unity-side fan-out"
status: active
created: 2026-10-24
origin: "reactor-sim build U6/U7/U8 serial bottleneck; user asks for 'all the things happening together and chronologically as well as needed'"
type: feature
---

# Chronological parallel build

## Problem frame

The reactor-sim build plan has two long sequential stretches:

1. U6 (Unity control desk) → U7 (Photon Fusion co-op) → U8 (mission arc) ran one after another in the same checkout, each with a 90-minute timeout. U7 took 2h 33m and U8 took 1h 27m on free OpenCode models, giving a ~4h wall-clock tail after all core work was done.
2. Timestamps in agentflow journals and run-ids are UTC (`2026-10-24T03:15:36.533Z`), but the operator console and `agentflow watch` show the bare ISO string. On a machine in `America/Denver` this is 6–7 hours offset and easy to misread.
3. Phases are declared as an ordered list, but the script itself decides what is parallel (`parallel([...])`) and what is serial (`must(await ...)`). There is no first-class dependency graph, so units that could run concurrently wait behind an earlier phase even when their inputs are ready.

## Status key

`done` merged · `in-review` open PR · `planned` not started · `candidate` worth doing only if the stated trigger is met

## Now

### U1. Fan out Unity-side units in reactor-sim-build.mjs
- **Status:** planned. Evidence: the current script at `reactor-sim/.agentflow/workflows/reactor-sim-build.mjs` runs U6, then U7, then U8 serially with a shared checkout.
- **Dependencies:** `worktree: 'auto'` already lands in M6; `phase()` journal records already land in the watch-view work.
- **Approach:**
  - Run U6 serial first because U7 and U8 both extend `PlantBridge.cs` and the panel.
  - Run U7 and U8 in `worktree: 'auto'` parallel worktrees.
  - Add an `integrate-unity` phase that merges the two worktrees into master and reconciles `PlantBridge.cs`.
  - Give U7 and U8 different starting models so they do not both hammer the same free-tier provider.
- **Verification:** a fresh run of `reactor-sim-build.mjs` shows U7 and U8 in parallel in `agentflow watch`, wall time for the Unity tail drops to `max(U7, U8) + integration` instead of `U7 + U8`.
- **Difficulty:** easy. No agentflow core changes required.
- **Feasibility:** high. U7 and U8 produce mostly non-overlapping files (`Net/` vs `Missions/`, `MissionEngine.cs` vs `SimStateSync.cs`). The only shared files are `PlantBridge.cs` and possibly `PanelReadout.cs`; the integrator resolves those.

### U2. First-class dependency graph in workflow scripts
- **Status:** candidate. Trigger: another build with more than one long serial tail.
- **Approach:** extend `meta` to accept a `deps` map, e.g.:
  ```mjs
  export const meta = {
    phases: ['u6', 'u7', 'u8', 'integrate-unity'],
    deps: {
      u7: ['u6'],
      u8: ['u6'],
      'integrate-unity': ['u7', 'u8'],
    },
  };
  ```
  The runner topologically sorts and executes ready phases concurrently up to a `--concurrency` limit.
- **Verification:** a synthetic workflow with two independent long phases finishes at the longest phase, not the sum.
- **Difficulty:** medium. Touches `runtime.mjs`, `watch.mjs`, and the journal schema.
- **Feasibility:** medium. The `phase()` function already marks boundaries; wiring it to a scheduler is incremental.

### U3. Local-time display in `watch`, `status`, and run-ids
- **Status:** planned. Evidence: user said "check timezone too" after seeing UTC run timestamps.
- **Approach:**
  - Keep journal records in UTC (they are the source of truth and survive machine moves).
  - Render `watch`/`status`/`list` timestamps in the runner's local timezone with an explicit offset, e.g. `2026-10-23 21:15 MDT`.
  - Optionally accept `--utc` for operator choice.
- **Verification:** `agentflow status <run>` and `agentflow watch` display local time; `agentflow list` shows both UTC and local.
- **Difficulty:** easy.
- **Feasibility:** high. `Intl.DateTimeFormat` with `timeZoneName` is available in Node 20+.

### U4. Auto-kill duplicate downstream triggers
- **Status:** planned. Evidence: the reactor-sim finish trigger spawned two `reactor-sim-finish.mjs` runs 24 seconds apart.
- **Approach:** the launcher should write a lock file (`.agentflow/launched-finish-<run-id>`) or use `agentflow list` to check for an existing finish run before starting another.
- **Verification:** a build `run-end ok` only ever launches one finish run.
- **Difficulty:** easy.
- **Feasibility:** high.

## Later

### L1. Model-aware scheduling
- **Status:** candidate. Trigger: more runs on free models with per-provider caps.
- **Approach:** the runner could rotate the starting model per parallel branch so that two simultaneous agents do not start on the same provider. `withFallback` already does this; the runner could pass a phase index or branch index into a model picker.

### L2. Resume with dependency DAG
- **Status:** candidate. Trigger: dependency graph U2 lands.
- **Approach:** on `--resume`, the runner replays settled calls, then schedules only the phases whose dependencies are satisfied, not the whole linear list.

## Risks / open questions

1. U7 and U8 both edit `PlantBridge.cs`. If the integration agent cannot merge them cleanly, the build stalls. Mitigation: add `UNITY_PAIR_RULES` that limits each unit to additive, well-localized changes and forbids file deletions in shared files.
2. `worktree: 'auto'` produces many detached-HEAD worktrees. Without `agentflow clean` they accumulate. The existing `clean` command handles this, but it must be run after a completed build.
3. Local-time display can mislead if the runner moves across timezones. Keep UTC in the journal and convert only at render time.
