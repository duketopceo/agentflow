---
title: "M8 — OpenRouter batch adapter: async jobs for latency-tolerant calls"
status: ready_for_implementation
created: 2026-10-10
origin: "M5–M8 roadmap set (2026-10-10); research docs/research/orchestration-economics.md §3 flagged :batch as the remaining cost lever; OR Batch API verified live 2026-10-10"
---

# M8 — OpenRouter batch adapter: async jobs for latency-tolerant calls

## Problem

OpenRouter's Batch API is real and documented: `POST /api/v1/batches` accepts
`{endpoint, model, requests: [{custom_id, body}]}`, returns `202` +
`status: validating`; `GET /batches/{id}` polls
`validating|in_progress|finalizing|completed|failed|expired|cancelling|
cancelled`; terminal batches carry `results` keyed by `custom_id`. Pricing is
~40–60% off for ≤24h latency-tolerant work — the biggest untapped cost lever
in `docs/research/orchestration-economics.md`. Agentflow can't reach it: the
sync `spawnAgent` contract has no one-job-per-N-requests shape.

## Scope

### In scope

- `batch(specs)` script global on `--harness openrouter`: one submit → poll →
  array aligned to input (null per failed `custom_id`).
- Journal `batch` record `{batch_id, indices, hash}` — mid-poll interrupts
  resume by re-polling the existing id, never resubmitting.
- Abort-aware, bounded polling (defaults 15s interval, 2h overall — OR window
  is 24h; overridable per call + `agentflow.json`).
- `openrouter` adapter only; other harnesses fail fast with a clear error.
- Live verification run on a cheap `:batch` model (manual, non-CI).

### Out of scope

- Two-phase cross-run submit/collect — v1 batch() is a slower call, not a
  new lifecycle (deferred until real usage demands it).
- `provider.only` pinning, `allow_fallbacks` opts — submit uses OR's default
  cheapest-eligible routing.
- Non-`/v1/chat/completions` endpoints (`/responses`, `/messages`,
  `/embeddings`).
- Mixed-model fan-out — the API is one `model` per batch; v1 requires all
  items share one model.
- Batch `DELETE`/server-side cancel on `--stop`.

## Requirements

- **R1.** `batch(specs)` resolves to an array aligned to input order; failed
  or missing `custom_id`s settle `null`.
- **R2.** Each item consumes a normal call index — positional `--resume`
  accounting is unchanged.
- **R3.** Resume after mid-poll interrupt re-polls the journaled `batch_id`;
  a second `POST /batches` is never sent for the same index range + request
  content.
- **R4.** `batch()` on a non-batch adapter aborts the run before submitting,
  naming the constraint.
- **R5.** Poll loop honors `spec.signal` (SIGINT drain) and a deadline
  (`batchTimeoutMs`, default 2h; `batchPollMs`, default 15s — per-call opt +
  `agentflow.json`).
- **R6.** Terminal `failed`/`expired` → all items `null` with the batch
  error; per-request errors inside `completed` → those indices `null`.

## Key Technical Decisions

- **KTD1 — `batch(specs)` is its own global, not an `agent()` opt.** The API
  is one job per N requests; a `batch:true` opt would emit 1-request batches
  — no savings, wrong semantics. Array-in/array-out mirrors `parallel()`.
- **KTD2 — blocking-poll v1; two-phase deferred.** `batch()` as a slow call
  preserves call-order determinism and resume; the journal record covers the
  interrupt case. A detached collect-later API is backlog.
- **KTD3 — journal `batch` at submit, `agent` per item at collect — inside
  the pool task.** Same journal-before-slot-release invariant as sync calls
  (docs/solutions/agent-orchestration/pooled-subprocess-agents-invariants.md);
  per-item `agent` records keep positional replay identical.
- **KTD4 — schema stays prompt-level.** Batch request bodies reuse
  `buildBody` + `withSchemaPrompt`; native `response_format` is a later
  optimization.
- **KTD5 — same injectable-fetch seam as M5 U3.** Tests fake `/batches`
  responses without network; if this plan runs before M5, implement the
  minimal `fetchImpl` seam here (cross-plan dependency noted in U1).

## Implementation Units

### U1. openrouter batch client

**Goal:** adapter speaks `/batches` submit + poll + result mapping.

**Requirements:** R6 (partial), R4 prerequisite

**Dependencies:** M5 U3's `fetchImpl` seam, or implement it here if this plan
lands first

**Files:** `src/adapters/openrouter.mjs`, `tests/openrouter.test.mjs`

**Approach:** `supportsBatch: true` on the adapter; `submitBatch(model,
items)` → POST `{endpoint:'/v1/chat/completions', model, requests}` with
`custom_id: 'c<i>'` per item; `getBatch(id)` → GET. Uniform model enforced at
submit boundary: all items share one model or the caller errored earlier.
Same auth header + `fetchImpl` seam as the sync path.

**Test scenarios:**

- Submit body shape matches the API doc (endpoint, model, custom_id-keyed
  requests).
- `400` on a model with no `:batch` endpoint → error names the model.
- `401`/`403` → `permissionDenied:true`; `404` (`.only` mismatch class) →
  clear message, non-retryable.
- `getBatch` passes through status + `results`/`error` verbatim.

**Verification:** client functions are pure-ish and fully covered by faked
fetch; no network in tests.

### U2. `batch()` runtime global + journal resume

**Goal:** scripts get one new global with identical settle/resume semantics.

**Requirements:** R1, R2, R3, R4, R5, R6

**Dependencies:** U1

**Files:** `src/runtime.mjs`, `src/journal.mjs`, `tests/runtime.test.mjs`

**Approach:** `batch(specs)` — guarded by `adapter.supportsBatch` else throw
`batch() requires --harness openrouter` (run-end `error`, before submit).
Each item takes `i = callIndex++` (counts against `maxAgents`). Inside one
pool slot: uniform-model check → `submitBatch` → journal `{type:'batch',
batch_id, firstI, count, hash}` where `hash` canonicalizes the request array
→ poll `getBatch` on `batchPollMs` with `opts.sleep` until terminal or
`batchTimeoutMs`/abort → on `completed`, journal one `agent` record per item
(`ok`/error per `custom_id` result), resolve aligned array; on
`failed`/`expired`, journal per-item errors with the batch reason. Resume:
`Journal.load` exposes a pending batch record; when the replayed `batch()`
consumes the same `firstI..firstI+count` range and hashes equal → re-poll the
existing `batch_id` (zero resubmits); hash mismatch → warn + submit fresh.

**Test scenarios:**

- Fake fetch: POST once (`202 validating`) → GET `in_progress` → GET
  `completed` with results → array aligned, per-item `agent` records at the
  right indices; assert exactly one POST.
- `sleep` injected → poll loop instant in tests.
- Resume: seed journal `{type:'batch'}` pending + matching hash → second run
  polls existing id — still exactly one POST total; mismatched hash → new
  submit.
- Terminal `failed`/`expired` → all items `null`, error carries the reason.
- `completed` with per-request error on `c1` → index 1 `null`, others ok.
- Non-openrouter adapter → clean run error, zero fetch calls.
- Mixed per-item models → clear error before submit.
- Abort mid-poll → `run-end: interrupted`; batch record stays pending for
  resume.

**Verification:** positional resume semantics identical to sync calls;
interrupt can never double-spend a batch.

### U3. Docs + skill surface

**Goal:** `batch()` is discoverable and honestly scoped in the skill.

**Requirements:** R4 (documentation)

**Dependencies:** U2

**Files:** `skills/agentflow/SKILL.md`, `README.md`,
`agentflow.example.json`

**Approach:** globals table gains `batch` with the uniform-model + openrouter-
only constraints; cost section notes ~40–60% off vs sync for
latency-tolerant stages, ≤24h window; `agentflow.example.json` shows
`batchPollMs`/`batchTimeoutMs` if the config keys land.

**Test expectation:** none — docs only; verified by U4's real run following
the documented invocation.

**Verification:** a fresh agent reading SKILL.md can produce a correct
`batch()` call without reading adapter source.

### U4. Live verification (manual, non-CI)

**Goal:** one real cheap batch proves the wire contract end-to-end.

**Requirements:** R1 (live)

**Dependencies:** U2

**Files:** `examples/batch-smoke.mjs` (new), `docs/smoke-matrix.md` (row)

**Approach:** `batch-smoke.mjs` submits 3 trivial prompts on
`z-ai/glm-5.3-flash` (its `:batch` variant), run manually with
`OPENROUTER_API_KEY` from the orchestral eval key per workspace spend rules.
Record latency + cost as a smoke-matrix row; update the openrouter adapter
comment (`:batch` now supported via `batch()`).

**Test scenarios:**

- Run completes: 3/3 results aligned, journal shows one `batch` record +
  three `agent` records; cost row recorded.
- Interrupt mid-poll + `--resume` → completes without a second POST (checked
  against OR request logs or timing).

**Verification:** smoke-matrix has a verified batch row with date + model +
spend.

## Deferred to Follow-Up Work

- Two-phase cross-run collect (`batchSubmit`/`batchCollect` script
  primitives); detached batch polling.
- `provider.only`/`allow_fallbacks` opts; mixed-model auto-grouping into N
  batches; non-chat-completions endpoints.
- `DELETE /batches/{id}` on `agentflow stop`/SIGINT for spend hygiene.
- Batch support on non-openrouter providers if demand appears.
