---
title: "M5 — deterministic test surface + CI"
status: ready_for_implementation
created: 2026-10-10
origin: "M5–M8 roadmap set (2026-10-10 review); closes gaps found auditing v0.2–#6"
---

# M5 — deterministic test surface + CI

## Problem

The suite is already deterministic (echo adapter, env-injected failures, seeded
journals, zero model calls), but four gaps remain: `npm test` is broken on
Node ≥22 (`node --test tests/` treats the positional as a glob →
MODULE_NOT_FOUND), nothing runs the suite automatically (no `.github/`),
adapter `spawnAgent` glue is untested end-to-end — codex's `-o lastMsgFile`
capture has zero coverage, the exact seam the via-wrap-contract learning
flagged — the openrouter fetch/parse path can't run without network, and the
retries test burns ~4s of real wall-clock backoff (83% of suite time).

## Scope

### In scope

- Fix the `npm test` entry point for Node ≥20.
- Fake-binary e2e coverage for every subprocess adapter's `spawnAgent`
  (devin, claude, codex, opencode, ori), including via-ori wrap-through.
- Injectable-fetch seam on the openrouter adapter + response-parse tests.
- Injectable `opts.sleep` on `runScript` for retry backoff and grace polls.
- GitHub Actions workflow running the suite on push/PR.
- Housekeeping: close superseded PR #2 and delete remote `feat/v1-runner`.

### Out of scope

- `--strict` lint pattern expansion (`Date()`, `crypto.randomInt`,
  `performance.now`, env/fs reads) — a policy decision, tracked as deferred.
- Coverage instrumentation (c8), fuzz/property tests of the journal loader.
- Any live-model or network-dependent test — determinism is the point.

## Requirements

- **R1.** `npm test` exits 0 on the engines floor (Node 20) through current.
- **R2.** Every harness adapter's `spawnAgent` runs end-to-end deterministically
  in tests — argv → spawn → classify → parse — with no real binary required.
- **R3.** No unit test waits on real backoff; suite wall time ~1s class.
- **R4.** CI runs the full suite on push/PR across the supported Node range.
- **R5.** PR #2 and `feat/v1-runner` are retired (content landed via #1 squash).

## Key Technical Decisions

- **KTD1 — bare `node --test` in `package.json`.** Auto-discovery covers
  `tests/*.test.mjs` on every Node ≥18.13; verified locally on Node 26.7.0
  (47 tests discovered). Fewer moving parts than a glob form.
- **KTD2 — fake binaries on PATH, not recorded transcripts.** Stub executables
  exercise the real `spawnProcess` → `classifyFailure` → `parse` path including
  custom `spawnAgent` overrides (codex) — the seam
  `docs/solutions/agent-orchestration/via-wrap-contract.md` proved argv-only
  tests can't see. Transcript replay would need a DI refactor for less signal.
- **KTD3 — injectable seams, not monkey-patching.** `opts.sleep` on `runScript`
  and a test-only fetch override on openrouter keep production code honest and
  tests hermetic. Mutating `process.env.PATH` inside the spawn call needs no
  runtime change (spawnProcess already defaults `env` to `process.env`).
- **KTD4 — matrix `[20, 22, 24, 26]` on `ubuntu-latest`.** Engines floor through
  the release this machine runs. Suite is seconds; private-repo Actions
  minutes are trivial at this size.

## Implementation Units

### U1. Test entry point + PR housekeeping

**Goal:** `npm test` works again; stale review surface retired.

**Requirements:** R1, R5

**Files:** `package.json`

**Approach:** `"test": "node --test"` (replaces `node --test tests/`).
Separately: close PR #2 as superseded by #1 (`dcdcfca` landed the same work
squashed) and delete remote branch `feat/v1-runner` — its only commit is on
main already.

**Test scenarios:**

- `npm test` exits 0 on Node 26 locally; U5 proves the matrix range.
- `gh pr view 2` shows closed; `git ls-remote origin feat/v1-runner` empty.

**Verification:** fresh clone-era entry point is the one command a stranger runs.

### U2. Fake-bin harness + adapter e2e tests

**Goal:** deterministic end-to-end `spawnAgent` coverage for all five
subprocess adapters, including the codex file-capture override and via-ori
wrapping.

**Requirements:** R2

**Files:** `tests/fakebin/{devin,claude,codex,opencode,ori}` (executable Node
stubs, `#!/usr/bin/env node`), `tests/helpers.mjs` (PATH-prepend helper +
spec factory), `tests/fakebin.test.mjs`

**Approach:** each stub parses `process.argv` and emits the contract output the
adapter parses — claude → `{"type":"result","result":"PONG"}` envelope;
opencode → JSONL text-part events; codex → writes its final message to the
file named by its `-o` arg and prints nothing relevant on stdout; devin/ori →
plain text on stdout. Env knobs mirror echo's convention: `FAKEBIN_EXIT=<n>`,
`FAKEBIN_DENY=1` (permission-shaped stderr), `FAKEBIN_SLEEP=<ms>`. Tests
prepend `tests/fakebin` to `process.env.PATH` for the duration of each
`spawnAgent` call and restore after.

**Test scenarios:**

- Happy: each adapter `spawnAgent` → `ok:true`, text contains `PONG`;
  codex specifically proves the `lastMsgFile` read path (empty stdout + `-o`
  file content → still `ok`).
- Schema: `spec.schema` + stub emitting fenced JSON → `result.json` parsed.
- Failure: `FAKEBIN_EXIT=1` → `ok:false`, `error.message` classifies `exit 1`.
- Denial: `FAKEBIN_DENY=1` → `error.permissionDenied === true` per each
  adapter's patterns (stderr shaped per adapter regexes).
- Timeout: `FAKEBIN_SLEEP=5000` + `timeout:50` → `timedOut`, and with
  `retries:3` still exactly one attempt (no retry on timeout).
- Via: `spec.via:'ori'` on the codex adapter → the `ori` stub receives argv
  `ori codex --model <slug> exec …` (regression net for the codex custom-
  spawnAgent bypass in via-wrap-contract.md).
- Error path: `via:'ori'` on devin stub → `ok:false` with launcher error, no
  spawn.

**Verification:** removing any stub makes only its adapter's tests fail; suite
spawns no real harness binary.

### U3. openrouter fetch seam + parse coverage

**Goal:** the openrouter response/error paths are testable without network.

**Requirements:** R2

**Files:** `src/adapters/openrouter.mjs`, `tests/openrouter.test.mjs`

**Approach:** `spec.fetchImpl` (test-only override, defaults to global
`fetch`) threaded through `spawnAgent`. Same seam later serves M8's `/batches`
client — name it once.

**Test scenarios:**

- `200` with `choices[0].message.content` → `{text, json:null}`.
- `spec.schema` + JSON content → `json` extracted via `extractJson`.
- `401`/`403` → `permissionDenied:true`; `500` → error message contains
  `openrouter:`.
- Empty `content` → `empty completion` error (the observed glm flake shape).
- `fetchImpl` rejects with `TimeoutError` → `timedOut:true` (retry-eligible
  classification, unlike HTTP errors which stay non-retryable by code shape).

**Verification:** all openrouter paths covered except a live request; existing
no-key test unchanged.

### U4. Injectable sleep + suite wall-time cut

**Goal:** retry-backoff and grace-poll waits become instant under test.

**Requirements:** R3

**Files:** `src/runtime.mjs`, `tests/runtime.test.mjs`

**Approach:** `opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))`;
thread it through the three literal `setTimeout` sites — retry backoff, the
grace `inFlight` poll loop, and the post-abort settle wait. No behavior change
for callers that don't pass it.

**Test scenarios:**

- Existing `retries:` tests pass `sleep: () => Promise.resolve()` — assert
  retry log lines and attempt counts unchanged; test file completes in <300ms
  (currently ~4s).
- SIGINT integration test stays real-clock (it spawns the CLI) — bump
  `AGENTFLOW_ECHO_SLOW` 500→800 and keep the 350ms signal point so queued
  calls still can't start on a loaded CI runner.

**Verification:** suite duration under ~1.5s excluding the CLI/SIGINT
integration tests.

### U5. CI workflow

**Goal:** every push/PR runs the suite on the supported Node range.

**Requirements:** R1, R4

**Files:** `.github/workflows/test.yml`

**Approach:** `on: [push, pull_request]`; matrix `node: [20, 22, 24, 26]` on
`ubuntu-latest`; steps: checkout → `actions/setup-node` → `npm test` →
`bin/agentflow run examples/smoke.mjs --harness echo` →
`bin/agentflow run examples/parallel-audit.mjs --harness echo` (echo needs no
credentials — a free CLI end-to-end check).

**Test scenarios:**

- Workflow exists, runs, and is green on the PR that introduces it.
- `npm test` passing on the Node 20 leg proves the R1 floor.

**Verification:** checks appear on the PR; no secrets or live-model steps
anywhere in the workflow.

## Deferred to Follow-Up Work

- `--strict` lint expansion decision (env/fs/`performance.now` class).
- Coverage tooling; fuzz/property tests for `Journal.load` corrupt-line paths.
- A `tests/fixtures/` corpus of captured real adapter output beyond the
  existing opencode-events file — only if a parse regression ever slips the
  fake-bin net.
