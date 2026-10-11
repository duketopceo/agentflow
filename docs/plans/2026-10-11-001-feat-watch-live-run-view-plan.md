---
title: "agentflow watch — live animated run view"
status: ready_for_implementation
created: 2026-10-11
origin: "user request 2026-10-11: 'can i watch it live, highly animated visual and live?' — the journal already events every state change; what's missing is (a) in-flight progress signals and (b) a renderer"
---

# agentflow watch — live animated run view

## Problem

`agentflow tail <run-id>` streams journal events as text lines — a log, not a
view. There is no way to see a run's *shape* while it moves: which calls are
queued, which are in-flight, how far a batch has gotten. Two gaps block it:

1. **No progress signal.** The journal only records *settled* calls
   (`agent` records are appended on completion) plus `batch`/`run-start`/
   `run-end`. An in-flight call emits nothing — a renderer reading today's
   journal can show "settled 4/11" but never "index 5 has been running 40s".
2. **No renderer.** `tail` prints one line per settled event; nothing keeps
   a spatial layout (per-index lanes, batch progress, elapsed clock) alive
   on screen.

## Scope

### In scope

- Journal progress records: `in-flight` on call start (per index; batch
  marks all its item indices), `batch-poll` per getBatch cycle
  (`{batch_id, status, pending, settled, total, at}`).
- `agentflow watch [run-id]` — zero-dep ANSI TUI that folds the journal
  event stream into a live per-index state view. No arg → newest journal in
  cwd's `.agentflow/runs/`.
- Non-TTY fallback: when stdout isn't a TTY, emit the same event stream
  `tail` does (watch IS tail with a renderer on top).
- Exit on `run-end` showing the final frame; return `endCode(ended)`.

### Out of scope

- Interactive input (pause/reorder/kill from inside the view) — `stop`
  already owns run control.
- Multi-run or historical browse view.
- Web/GUI dashboard — the journal is the data source; a web view is a later
  consumer of the same records.
- Rendering partial stdout/stderr content of in-flight calls — the journal
  doesn't carry streaming output and won't start.
- Editing the run — watch is strictly read-only.

## Requirements

- **R1.** Every call emits `{type:'in-flight', i, label, model, at}` before
  spawn; every `batch()` item index emits one at submit time. `batch-poll`
  records carry status + counts on each poll.
- **R2.** New record types never affect resume: `Journal.load` keeps
  `settled`/`batches`/`ended` semantics identical (in-flight is not `agent`;
  verified — `load` ignores unknown types).
- **R3.** `watch` derives per-index latest state by folding the event
  stream: `in-flight` → `agent` (settled) or dead-at-`run-end`; batch items
  show poll status until their own `agent` record lands.
- **R4.** TTY: alternate-screen ANSI view, ~4fps, redraws on journal change;
  per-index lane, batch lane with poll progress, elapsed clock, settle
  meter. Small terminals truncate gracefully.
- **R5.** Non-TTY output is byte-for-byte the `tail` event stream (drop-in
  for scripts/pipes).
- **R6.** `watch` exits on `run-end` with the run's end code; missing
  run-id/journal exits 2 with a clear message; orphaned pid (dead run, no
  `run-end`) is surfaced in the header, not hung on forever — same check as
  `tail`/`stop` already do.

## Key Technical Decisions

- **KTD1 — progress lives in the journal, not a sidecar file.** The journal
  is already the append-only event log every consumer reads; `in-flight`/
  `batch-poll` are just two more record types. Backward-compatible by
  construction (`load` skips unknown types), and `--resume` on an older
  journal simply has no progress records to show.
- **KTD2 — watch is a separate command, not a `run` flag.** Runs can be
  `--detach`ed, resumed, or watched from a second terminal; a renderer
  bound to the run process could do none of that. `--detach`'s hint line
  updates to suggest `watch`.
- **KTD3 — zero-dep ANSI, same re-read loop as `tail`.** No blessed/ink
  dep: cursor-home + clear-line redraw at ~250ms (or on `fs.watch` of the
  journal), reading the whole file each tick like `statusCmd` does —
  journals are small and append-only.
- **KTD4 — state is derived, never stored.** Watch recomputes the per-index
  state table from the event stream each frame; no mutable view model to
  drift out of sync with the journal.

## Implementation Units

### U1. Journal progress records

**Goal:** in-flight work and batch polls are visible to journal readers.

**Requirements:** R1, R2

**Files:** `src/runtime.mjs`, `src/journal.mjs`, `tests/journal.test.mjs` (or
batch/runtime tests)

**Approach:** append `{type:'in-flight', i, label, model, at}` at pool-task
start (before spawn); for `batch()`, emit one per item index at submit and
`{type:'batch-poll', batch_id, status, pending, settled, total, at}` on each
`getBatch` cycle (cheap lines — polls are ≥1s apart). `Journal.load` gains
`inFlight: Map` + `lastBatchPoll` in its meta for `status`/`watch` consumers
(existing `settled`/`batches`/`ended` unchanged). Resume: records from a
prior epoch are stale context only — replay semantics read `agent` records
exactly as today.

**Test scenarios:**

- Run a script: journal contains `in-flight` records preceding each `agent`
  record for the same index; batch items all emit `in-flight` at submit.
- `Journal.load` on a journal containing the new types: `settled` map
  identical to before, `batches` unaffected, `inFlight` exposes open items.
- Resume on a journal with stale `in-flight` + `batch-poll` records: replay
  is unchanged (settled replayed, unsettled re-run).
- `batch-poll` reflects getBatch statuses in order.

**Verification:** resume/replay tests green; load meta shape additive only.

### U2. `agentflow watch` renderer

**Goal:** a live animated view of any run from its journal.

**Requirements:** R3, R4, R5, R6

**Dependencies:** U1 (progress records) — view still works without them, just
never shows in-flight lanes

**Files:** `src/cli.mjs` (watchCmd), `src/watch.mjs` (new — pure fold +
render), `tests/watch.test.mjs`

**Approach:** `watch.mjs` exports two pure functions: `foldState(records)`
→ `{meta, lanes: [{i, label, state, secs}], batch: {…}, done}` and
`renderFrame(state, {now, width, spinner})` → string. cli.mjs adds
`agentflow watch [run-id]`: resolve newest journal when no arg; TTY →
alt-screen + `hideCursor`, tick ~250ms reloading journal, `renderFrame`
each tick, on `run-end` show final frame then restore screen and return
`endCode`; non-TTY → the `tail` event stream verbatim. Spinner frames +
elapsed use an injectable `now`/`tick` for tests. Header shows run-id,
script, harness, elapsed, pid-liveness (same `pidState` check `stop` uses).
Lanes: `◌ queued → ◐ in-flight (age) → ● ok / ○ null`; batch lane shows
`status`, `pending`/`settled` counts from the latest `batch-poll`, and the
claim-ticket `batch_id` (truncated).

**Test scenarios:**

- `foldState` on a recorded sequence: queued→in-flight→ok transitions per
  index; batch in-flight → per-item settle; `run-end` marks done; stale
  in-flight with `run-end:interrupted` shows abandoned.
- `renderFrame` deterministic output for a fixed state + `now` + tick —
  snapshot-assert the frame (labels, lane states, batch progress, elapsed).
- Non-TTY mode prints exactly the `tail` event lines for the same journal.
- `watch` on a missing run-id → exit 2, clear message.
- Child-process e2e: run script + `watch` concurrently → run completes,
  watch exits 0, captured frames show at least one `in-flight` lane then
  final `● ok` lanes.
- Small width → no crash, lanes truncated not wrapped.

**Verification:** every render is pure; the only I/O is journal read +
stdout write.

### U3. Docs + ops surface

**Goal:** discoverable in the places agents/users look.

**Requirements:** R4 (documentation)

**Dependencies:** U2

**Files:** `README.md`, `skills/agentflow/SKILL.md`, `src/cli.mjs` USAGE +
`--detach` hint

**Approach:** ops table gains `watch`; `--detach` prints `watch:` hint
(alongside existing `tail`/`status` lines); SKILL.md notes in-flight/
batch-poll records exist in journals for consumers.

**Verification:** `agentflow` USAGE text + SKILL.md commands table agree
with the built flags (covered by existing cli help test if present).

## Deferred to Follow-Up Work

- Watch inside `run` (`--watch` flag spawning the view on the same run).
- Multi-run overview; finished-run playback mode (`--speed` replay).
- Web dashboard consuming the same journal records.
- Per-call live output streaming (requires journals to carry output chunks —
  a separate decision).
