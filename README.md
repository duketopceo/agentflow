# agentflow

Cross-harness dynamic workflows: write an orchestration script once, fan out
one-shot agent sessions (`devin -p`, `claude -p`, `codex exec`, `opencode run`)
under a bounded concurrency pool, with journaled results and resumable runs.

The orchestration state lives in the script, not in a model's context window —
the same architectural move as Claude's native workflows, delivered as a
portable subprocess runner.

## Quickstart

```bash
bin/agentflow run examples/parallel-audit.mjs --harness echo
bin/agentflow doctor
```

A workflow script is an `.mjs` file with top-level `await`:

```js
export const meta = { name: "audit", description: "..." };

const results = await parallel(files.map((f) => () =>
  agent(`Review ${f}`, { label: `review:${f}`, model: "cheap" })
));

const good = results.filter(Boolean);
```

Globals inside a script: `agent()`, `parallel()`, `pipeline()`, `batch()`,
`phase()`, `log()`, `args`. `batch()` fans out through the harness's async
surface — one OR Batch job on `--harness openrouter` (~40–60% cheaper),
one Devin Cloud session per item on `--harness devin` (`swe-2` models are
free), or first-party batch APIs on `--harness openai`/`--harness anthropic`
(~50% off, 24h window). Results align to input order; resumable mid-poll.

## Install as an agent plugin

The repo carries a manifest for each harness; all resolve to the shared
`skills/agentflow/` directory.

| Harness | Install |
|---|---|
| Devin | `devin plugins install --local /path/to/agentflow` (reads `.devin-plugin/`; auto-installs the compound-engineering plugin via `requiredPlugins`) |
| Claude Code | `claude plugin marketplace add duketopceo/agentflow` → `.claude-plugin/` — though inside Claude, prefer the native Workflow tool |
| Codex | `codex plugin marketplace add duketopceo/agentflow` → `.codex-plugin/` |
| OpenCode | `opencode plugin add github:duketopceo/agentflow` — native plugin with `agentflow_run`/`agentflow_doctor` tools; see `.opencode/INSTALL.md` |
| Ori/OpenRouter | no plugin surface — run `agentflow` CLI directly with `--harness ori` / `--harness openrouter` or `--via ori` |

The `agents/worker.md` profile gives Devin a cheap disposable subagent
(`swe-2-*` free tier or `claude-haiku-5-5-low`) for extraction-class fan-out.

## Docs

- `skills/agentflow/SKILL.md` — agent-facing guidance (installed per harness)
- `docs/plans/` — design history
- `docs/smoke-matrix.md` — live per-adapter verification results
- `docs/research/` — cross-harness landscape + orchestration economics

## Status

Early development. Adapter matrix tested versions are in `bin/agentflow doctor`
output and each adapter's source comments.
