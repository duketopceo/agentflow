---
title: "openai + anthropic direct adapters — first-party batch APIs"
status: ready_for_implementation
created: 2026-10-11
origin: "user request 2026-10-11: extend batch() to the remaining providers; CLI harnesses can't batch (synchronous), so direct API adapters close the gap. Hard constraint: NO SPEND — deterministic verification only, live smoke deferred behind a human gate"
---

# openai + anthropic direct adapters — first-party batch APIs

## Problem

`batch()` has three working backends (openrouter `/batches`, devin `/v3`
sessions, perplexity `/v1/async/sonar`). OpenAI and Anthropic both run
first-party batch APIs at ~50% off — the same discount class as OR — but
the `claude`/`codex` adapters can't reach them: those adapters wrap CLIs,
and a subprocess is synchronous by nature. The fix is two direct-API
adapters implementing the established batch contract — verified entirely
without live calls per the no-spend constraint.

## Scope

### In scope

- `openai` adapter: sync `agent()` on `POST /v1/chat/completions` +
  `supportsBatch` on the Batches API.
- `anthropic` adapter: sync `agent()` on `POST /v1/messages` +
  `supportsBatch` on Message Batches.
- Same adapter contract as openrouter/devin/perplexity: `buildBody`,
  `batchBody`, `submitBatch`, `getBatch`, `batchResultMap` (shared from
  `base.mjs`), `batchItemResult`, `probe`, `supportsBatch`.
- Env seams: `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`;
  `AGENTFLOW_OPENAI_BASE`/`AGENTFLOW_ANTHROPIC_BASE` base overrides;
  `fetchImpl` throughout.
- Deterministic tests only — zero live calls, zero spend.

### Out of scope

- **Live verification — deferred behind a human gate** (explicit user
  constraint: don't use these providers). smoke-matrix rows are recorded as
  deterministic-only; a live run happens only if the user opts in later.
- `codex`/`claude` CLI adapters gaining batch — impossible by construction
  (no async surface); these API adapters are the answer, not CLI flags.
- File/embedding/fine-tune endpoints; tool-use parameters; vision payloads.
- Batch cancel/delete on `agentflow stop` (already deferred for OR/devin).
- OpenAI `output_file_id` streaming partial results mid-run.

## Requirements

- **R1.** Both adapters implement the full batch contract; `batch()` on
  `--harness openai`/`--harness anthropic` produces index-aligned arrays
  through the unchanged runtime path.
- **R2.** `agent()` sync calls work on both adapters with the standard
  `{text, json}` result; `schema:` stays prompt-level via `withSchemaPrompt`.
- **R3.** Auth is env-only (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`); missing
  key fails cleanly on every entrypoint; 401/403 → `permissionDenied`.
- **R4.** Resume semantics preserved: journaled `batch_id` re-polls without
  resubmitting — identical to the other backends (composite id or single id
  as each API dictates).
- **R5.** All wire interactions injectable via `fetchImpl`; every test is
  network-free.
- **R6.** Per-item failures settle `null` only for that index (per-request
  error entries inside completed results; terminal-without-result items).

## Key Technical Decisions

- **KTD1 — openai submit is two calls inside `submitBatch`.** OpenAI Batches
  require a JSONL upload first: `POST /v1/files` (multipart, `purpose:
  'batch'`, lines `{custom_id, method:'POST', url:'/v1/chat/completions',
  body}`) → `POST /v1/batches {input_file_id, endpoint, completion_window:
  '24h'}`. `submitBatch` does both and returns only the batch id — the file
  id is transient (a failed second call orphans a harmless upload). The
  journaled `batch_id` is just the batch id — resume re-polls it directly.
- **KTD2 — result collection happens inside `getBatch`.** OpenAI terminal
  `completed` batches expose `output_file_id` — `getBatch` fetches
  `GET /v1/files/{id}/content` (JSONL `{custom_id, response:{status_code,
  body}, error}`) and returns the normalized results array in one
  `{status:'completed', results}` response. Anthropic `ended` batches expose
  `results_url` — same inside-getBatch fetch+parse pattern. The runtime
  sees one uniform terminal shape.
- **KTD3 — anthropic quirks live in `buildBody`/`batchItemResult`.**
  `max_tokens` is required (default 8192, overridable per item); `system`
  stays out (schema instruction stays in the user message, consistent with
  the other adapters); response content blocks `[{type:'text',text}]` →
  `text`; per-item result `type` maps: `succeeded` → `message`, `errored`/
  `expired`/`canceled` → per-item error. Auth header is `x-api-key` +
  `anthropic-version: 2023-06-01` (and `anthropic-beta:
  message-batches-2024-09-24` on the batches endpoints — include
  unconditionally; harmless if GA'd).
- **KTD4 — verify-at-implement-time list, not assumptions.** Unverified
  details are marked here and pinned by tests where possible; where the
  wire can't be checked without spend, the adapter comment + smoke-matrix
  row say so honestly: exact model slugs (defaults below), whether Message
  Batches still needs the beta header, OpenAI `output_file_id` presence on
  `expired` batches (partial results — v1 ignores them), and multipart
  upload field names (`purpose`, `file`).
- **KTD5 — defaults.** openai model default `gpt-4.1-mini`; anthropic model
  default `claude-haiku-4-5` — both cheap-tier placeholders to be confirmed
  at implement/live time, documented in the adapter comment like the others.

## Implementation Units

### U1. `anthropic` adapter

**Goal:** sync + batch contract on `api.anthropic.com`.

**Requirements:** R1–R6

**Files:** `src/adapters/anthropic.mjs`, `src/adapters/index.mjs`,
`tests/anthropic.test.mjs`

**Approach:** `spawnAgent` → `POST /v1/messages` `{model, max_tokens,
messages:[{role:'user',content}]}` → `{content:[{type:'text',text}]}`;
`batchBody` → `{custom_id, params:{model,max_tokens,messages}}` minus
custom_id (hash material = params); `submitBatch` → `POST
/v1/messages/batches {requests}` → `{id, processing_status}`; `getBatch` →
`GET /v1/messages/batches/{id}`: `in_progress`/`canceling` → keep polling;
`ended` → fetch `results_url`, parse JSONL → `results` array; per-item
`result.type` → `succeeded` → message body, others → `{error}`. Status
mapping to runtime: only `completed` triggers collect; expose `ended` as
`completed` in the getBatch return (`b.status` checked verbatim — map
`ended` → `'completed'` at the adapter boundary).

**Test scenarios:**

- Submit body: `requests` array with `custom_id` `c0..cN`, `params`
  carrying model/max_tokens/messages; `x-api-key` + `anthropic-version`
  headers present.
- `getBatch`: `in_progress` → keep; `ended` + results_url → fetches JSONL,
  maps `succeeded`/`errored`/`expired` per `custom_id`.
- `spawnAgent`: text extraction, `max_tokens` default + override, schema
  prompt expansion, empty content → clean error, 401 → permissionDenied.
- Missing `ANTHROPIC_API_KEY` → clean error on all entrypoints.
- `batchItemResult`: message → `{text,json}`, error entry → errResult.

### U2. `openai` adapter

**Goal:** sync + batch contract on `api.openai.com`.

**Requirements:** R1–R6

**Files:** `src/adapters/openai.mjs`, `src/adapters/index.mjs`,
`tests/openai.test.mjs`

**Approach:** `spawnAgent` → `POST /v1/chat/completions` (same shape as
openrouter minus routing opts); `batchBody` → chat-completions body;
`submitBatch` → upload JSONL (`{custom_id, method, url, body}` lines) via
`POST /v1/files` → `POST /v1/batches` → `{id,status}`; `getBatch` →
`GET /v1/batches/{id}`: non-terminal → status passthrough; `completed` →
fetch `output_file_id` content, parse JSONL `{custom_id, response:
{status_code, body}, error}` → results; `failed|expired|cancelled` → batch
error to runtime. Multipart upload via `FormData`/`Blob` (Node 20 native).

**Test scenarios:**

- Submit performs exactly two calls: file upload (JSONL parses, custom_ids
  aligned, url `/v1/chat/completions`) then batch create (`input_file_id`,
  `completion_window: '24h'`); returns the batch id.
- `getBatch` on `completed` fetches output file once, maps per-custom_id
  `response.body`/`error` entries.
- Terminal `failed|expired` → batch-level error passthrough to runtime.
- `spawnAgent`/`batchItemResult`/missing-key/permissionDenied — same
  coverage as anthropic U1.

### U3. Runtime e2e + registry + docs

**Goal:** both adapters run through the real `batch()` path and are
discoverable.

**Requirements:** R1, R4

**Dependencies:** U1, U2

**Files:** `tests/batch.test.mjs` (two blocks), `README.md`,
`skills/agentflow/SKILL.md`, `docs/smoke-matrix.md`, `package.json`
(files whitelist check)

**Approach:** append `openai batch:` and `anthropic batch:` blocks mirroring
the perplexity block — e2e aligned results + journal records, resume
re-polls journaled id (zero new submits), per-item failure settles only
that index. SKILL.md adapter table + `batch` global row gain both rows with
the env keys; smoke-matrix gains **deterministic-only** rows explicitly
marked "live deferred — no-spend gate"; adapter comments carry the
verify-at-implement-time list from KTD4.

**Test scenarios:**

- Per adapter, the 3 e2e scenarios via `runScript` + `stubFetch`.
- `Object.keys(adapters)` test updated for +2 adapters.
- Docs: a fresh agent reading SKILL.md writes a correct `batch()` call on
  either new harness.

**Verification:** suite green; zero network assertions hold (no test makes
a real request — stubFetch throws on unstubbed calls).

## Deferred to Follow-Up Work

- **Live verification of both adapters** — human gate; smoke-matrix rows
  flip from "deterministic-only" to verified when opted in.
- Anthropic beta-header removal if GA; `system` param support; tool-use
  params; OpenAI partial results on `expired`.
- Batch cancel/delete on `stop` (cross-adapter, already deferred).
- A generic "provider list/reconcile" surface (OpenAI `GET /batches` list
  exists — same future `agentflow reconcile` idea as perplexity/devin).

## Risks

- **Wire-shape drift unverified live.** Mitigation: contract is identical
  to three working adapters; every field is unit-tested against the
  documented shape; honest "unverified live" marking in docs/comments; the
  live gate flips cheap (one env key + one run).
- **Model slug guesses.** Defaults are placeholders documented as such;
  wrong-slug errors surface cleanly through the existing error path.
- **Anthropic API surface details (beta header, results_url auth).** Tests
  pin the documented shape; if the live gate later shows drift, the fix is
  isolated to one adapter file.
