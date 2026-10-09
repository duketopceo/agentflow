# The via-wrap contract: every spawnAgent must route through applyVia

## What happened

`--via ori` wrapping lived in the generic `spawnAgent` in
`src/adapters/base.mjs`. Codex overrides `spawnAgent` (it needs a temp dir for
`--output-last-message` + `--output-schema` files) and called `spawnProcess`
directly — so `--via ori` silently produced a **bare** codex invocation with an
OpenRouter model slug: `codex exec -m z-ai/glm-5.3-flash` → exit 1. Found only
by the live smoke matrix; no test caught it because the argv-unit tests
exercise `buildArgv`/`applyVia`, not the override path.

## The invariant

Any adapter that overrides `spawnAgent` must still run
`applyVia(this, buildArgv(...), spec)` and honor `wrapped.error`. The wrap is
not decoration — it rewrites the binary (`argv[0]` becomes ori's subcommand),
moves model routing to ori's `--model`, and injects `--reasoning-effort`.
Skipping it is not a degraded mode; it produces a *wrong binary invocation*.

Two failure shapes this prevents:

- **Silently direct:** credentials/model billed to the wrong provider
  (subscription instead of OpenRouter, or an OR slug rejected by the native
  provider — codex's case).
- **Leaked native flag:** adapter's `-m`/`--model` forwarded untouched into a
  harness that doesn't know OpenRouter slugs.

## Test guidance

Argv-level tests can't see into a custom `spawnAgent`. The catch that works is
the live smoke matrix (`docs/smoke-matrix.md`) — every adapter × `--via ori`
must produce a real `PONG`. If an adapter gains a custom `spawnAgent`, add the
`applyVia` call and re-run that row.

## Related findings worth keeping

- Codex's session header prints `provider: openai` even when ori routes to
  OpenRouter — it's a generic OpenAI-compatible label, not evidence of
  misrouting.
- `z-ai/glm-5.3-flash` returns `empty completion` intermittently under burst
  concurrency (~5/12 calls in one deep-research run). Tolerated as `null`;
  a retry-on-empty opt is a candidate follow-up.
