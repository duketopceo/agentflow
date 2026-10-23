# Live adapter smoke matrix — v0.2

Rows below are reproducible: `node scripts/smoke-harnesses.mjs` re-runs the
same per-adapter invocations (120s timeout) and prints markdown rows;
`--json` for machines, `--only <csv>` to filter.

Run 2026-10-09 from `/tmp/af-smoke` (isolated scratch dir; journals under
`.agentflow/`). Invocation: `agentflow run smoke.mjs --harness <h> -- <model>`.
Cost posture: free/cheap routes only — no Anthropic or premium spend.

| Harness | Invocation | Result | Latency | Spend |
|---|---|---|---|---|
| devin | `--harness devin -- swe-2-medium` | PONG | 11.2s | free (swe-2 tier) |
| ori | `--harness ori -- z-ai/glm-5.3-flash` | PONG | 4.0s | $0.00006 (ori reports per-call) |
| openrouter | `--harness openrouter -- z-ai/glm-5.3-flash` | PONG | 1.5s | ~$0.00005 direct API, no subprocess |
| claude (via ori) | `--harness claude --via ori -- z-ai/glm-5.3-flash` | PONG | 17.8s | OpenRouter key |
| codex (via ori) | `--harness codex --via ori -- z-ai/glm-5.3-flash` | PONG | 22.6s | OpenRouter key |
| opencode (via ori) | `--harness opencode --via ori -- z-ai/glm-5.3-flash` | PONG | 18.9s | opencode's stored OpenRouter credential |
| echo | `--harness echo` | n/a | — | free, test-only |

## Findings this matrix produced

- **codex custom spawnAgent bypassed `applyVia`** — `--via ori` never wrapped
  codex; it ran bare `codex exec -m <or-slug>` → exit 1. Fixed by applying
  `applyVia` inside codex.mjs.
- **`ori codex` consumes `--model` itself** and forwards the rest; codex's
  session header still labels provider `openai` (generic OpenAI-compatible
  label) while requests route to OpenRouter. Verified working.
- **opencode global config was invalid** (`mcp.kurultai-personal` used
  `type: stdio` + string `command` + separate `args`, missing `enabled`) —
  opencode refused to start. Repaired to `type: local` with merged command
  array (backup at `opencode.json.bak-agentflow`).
- **opencode's stored OpenRouter key shadows Ori's injected key** — ori warns
  but the run succeeds on the stored credential. Documented behavior, not a
  bug; removing the stored key would flip billing to Ori's credential.
- **`swe-2-medium`/`swe-2-high`/`swe-2-max` are the free devin models**
  (there is no `swe-2-lite`); `claude-haiku-5-5-low` remains the cheap paid pin.
- **codex prints `Reading additional input from stdin...`** with piped stdin —
  harmless; `stdio: ['ignore']` gives it EOF and it proceeds.

## End-to-end: deep-research on openrouter/glm-5.3-flash

`agentflow run deep-research.mjs --harness openrouter` (all stages glm):
decompose (6 sub-questions) → 5/6 researchers returned → adversarial
cross-check → synthesis. ~308s wall, ~12 calls, ~$0.003 total spend.

**Finding:** `z-ai/glm-5.3-flash` intermittently returns `empty completion`
under burst concurrency (5 of 12 calls) — the runner journals them as failed
(`null`) and the workflow degrades gracefully, but cheap-model flakiness is
real. A `retries` spec opt or automatic single-retry-on-empty is a candidate
follow-up; `--cache` + `--resume` already bound re-run cost.

## Batch API (2026-10-10, live OR, orchestral eval key)

`agentflow run examples/batch-smoke.mjs --harness openrouter` — 3 prompts on
`z-ai/glm-5.3-flash`, one `POST /batches` →
`batch-1791675963-VjJrEK4aMNaT2nKflOy6` (202, `validating` → `in_progress`,
24h window, model normalized to `glm-5.3-flash-20260826`).

| Step | Result |
|---|---|
| submit + journal `batch` record | verified — `{batch_id, firstI:0, count:3, model, hash}` appended post-submit |
| poll `in_progress` | verified — status passthrough correct |
| SIGINT mid-poll → `--resume` | verified — `re-polling journaled batch batch-1791675963-...`, zero second POSTs |
| `completed` → per-item results | deterministic-test verified; live completion pending — OR batch queue backlogged (glm 0/3 and deepseek-v4.1-flash 0/2 for >50min on 2026-10-10 evening) |

Note for operators: OR batch turnaround on cheap flash slugs can exceed an
hour in queue. `batch()` fits latency-tolerant stages only — keep
`batchTimeoutMs` sized to your tolerance (default 2h; window is 24h).

## Batch on devin (2026-10-11, live /v3 sessions)

`agentflow run devbatch.mjs --harness devin` — 3 prompts on `swe-2-medium`,
one Devin Cloud session per item (`POST /v3/organizations/{org}/sessions`,
`structured_output_required` → `{answer}`). Journal: one `batch` record with
the composite id (3 session ids), then 3 `agent` records at indices 0–2.

| Step | Result |
|---|---|
| submit 3 sessions + journal ids | verified — `["057f113d...","1bbdf5ca...","b39b2181..."]` |
| poll → `structured_output` per item | verified — 3/3 aligned results `["AA","BB","CC"]` |
| wall latency | 33.8s for 3 sessions — vs OR batch backlog the same evening |
| spend | free (`swe-2` tier; sessions observed at 0.0 ACUs) |

Operator note: a Devin session idles at `waiting_for_user` after producing
`structured_output` — completion is output-present, not status-terminal.
Sessions also carry `max_acu_limit`; swe-2 models observed consuming 0.0.

## Batch on perplexity (2026-10-11, live /v1/async/sonar)

`agentflow run b.mjs --harness perplexity` — 2 items, one async sonar
request each (`POST /v1/async/sonar {request: {model, messages}}` → poll by
request id; composite JSON slot list, same pattern as devin).

| Step | Result |
|---|---|
| submit 2 requests + journal ids | verified — `["req-…","req-…"]` composite `batch_id` |
| poll → `COMPLETED` + `response` | verified — 2/2 aligned, 113s wall |
| sync `agent()` on `sonar` | verified — grounded answer in 1.8s, `citations` flow into the result |
| spend | two `sonar-deep-research` reports (17 + 15 citations) + one `sonar` lookup — cents |

Operator note: **async accepts `sonar-deep-research` only** — the API
rejects other models with "Async processing is only available for
sonar-deep-research". That is the right batch model anyway (long cited
reports ~1–4min each); use `sonar`/`sonar-pro` for sync `agent()` calls.
Sonar async is slated for deprecation 2026-09-27 — Agent API
`/v1/responses` (same submit/retrieve shape) is the migration path.
## Batch on openai + anthropic (2026-10-11, deterministic only)

`batch()` on `--harness openai` (two-step `/v1/files` JSONL upload +
`/v1/batches` create, `output_file_id` results) and `--harness anthropic`
(one `POST /v1/messages/batches`, `ended` → `results_url` JSONL). Both
verified entirely by fake-fetch unit + runtime e2e tests — **live runs
deferred behind the no-spend human gate**. Wire shapes pinned to the
documented APIs; verify-at-implement-time items (multipart field names,
anthropic beta header, model slugs) are listed in the adapter comments
and plan KTD4.

| Surface | Verified (deterministic) | Live |
|---|---|---|
| openai `agent()` | text/json extraction, headers, 401→permissionDenied | deferred — no-spend gate |
| openai `batch()` | 2-call submit, aligned results, resume re-poll, per-item errors | deferred — no-spend gate |
| anthropic `agent()` | text-block join, `max_tokens` default/override, headers | deferred — no-spend gate |
| anthropic `batch()` | 1-call submit, `ended`→`completed`, results_url JSONL, per-item errors | deferred — no-spend gate |

## Hermes adapter (2026-10-23, live-verified single call)

`--harness hermes` — Hermes Agent CLI as a worker. Flags verified against
`hermes --help` and one live micro-run.

| Step | Result |
|---|---|
| `hermes --cli -z "Reply with exactly: PONG"` (live) | verified — plain text `PONG` on stdout, no envelope |
| `agentflow run` one-agent e2e via the adapter (live, profile default model) | verified — `ping -> ok (3.0s)`, `RESULT: PONG`, journaled `settled=1 ping:ok` |
| `--safe-mode` semantics | verified refusal without `--model`: "read no profile default: pass --model explicitly" — the adapter therefore emits `--safe-mode`/`--yolo` **only when the spec pins a model** |
| fakebin e2e (ok / schema / deny / forced-exit) | verified — `node --test tests/hermes.test.mjs` 8 tests + full suite 235 pass |
| schema | no native flag — prompt-level `withSchemaPrompt` + `extractJson`, same as claude/devin |
| usage | not journaled — hermes `-z` does not report token usage on stdout |

Operator note: workspace guardrails apply on top (a model allowed one minute
was guardrail-blocked the next after a provider-side policy change) — model
availability is the caller's concern, not the adapter's. `hermes` must be on
PATH; a spawn ENOENT classifies as a normal spawn failure and the run still
ends ok with the lane failed.
