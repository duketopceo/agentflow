---
title: "agent() retries — bounded retry on transient agent failures"
status: ready_for_implementation
created: 2026-10-09
origin: "v0.2 residual: glm-5.3-flash empty-completion under burst (5/12 calls nulled in e2e run)"
---

## Problem

Cheap models flake: the e2e deep-research run saw 5/12 `openrouter: empty
completion` failures under burst concurrency. Each null means a dropped
researcher/verifier — graceful but lossy. A bounded retry converts most flakes
into slightly slower successes.

## Scope

- `retries` spec opt on `agent()` + run-level default `--retries <n>` and
  `agentflow.json` `"retries"`. Default 0 (off) — opt-in, since retries
  multiply worst-case spend.
- Retry on `ok:false` EXCEPT `permissionDenied` (won't heal) and `timedOut`
  (rerun just burns another timeout). Linear backoff: `1000ms * attempt`.
- Log attempts via existing logLine; journal only the terminal settle
  (existing journal/resume semantics unchanged — a retried-then-ok call is one
  settled result at its call index; cache keys unchanged).
- Not in scope: backoff jitter config, per-error-type policy, circuit breakers.

## Implementation

- `src/runtime.mjs`: `retries` into KNOWN_AGENT_OPTS; resolve per call as
  `spec.retries ?? opts.retries ?? 0`; wrap the spawn call in a bounded loop,
  `logLine(\`${label} retry ${k}/${retries}\`)` between attempts, sleep
  `1000*k`.
- `src/cli.mjs`: `--retries` flag + `config.retries`.
- `skills/agentflow/SKILL.md`: one line under Cost discipline/Guards.

## Tests

- `tests/runtime.test.mjs`: echo adapter gains a `flaky` mode
  (`AGENTFLOW_ECHO_FAIL_N` env → fail first N calls) or a module-level counter;
  assert: retries=2 + fail-1 → ok with a retry log; retries=0 + fail-1 → null;
  retries cap honored (fail-3 + retries=1 → null after 1 retry).
- Assert permissionDenied and timeout are NOT retried.
