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

Globals inside a script: `agent()`, `parallel()`, `pipeline()`, `phase()`,
`log()`, `args`.

## Install as an agent plugin

The repo carries a manifest for each harness; all resolve to the shared
`skills/agentflow/` directory.

| Harness | Install |
|---|---|
| Devin | `devin plugins install -y duketopceo/agentflow` (or `--local /path/to/agentflow`) — reads `.devin-plugin/`; auto-installs the compound-engineering plugin via `requiredPlugins` |
| Claude Code | `claude plugin marketplace add duketopceo/agentflow` → `.claude-plugin/` — though inside Claude, prefer the native Workflow tool |
| Codex | `codex plugin marketplace add duketopceo/agentflow` → `.codex-plugin/` |
| OpenCode | `opencode plugin github:duketopceo/agentflow` — native plugin with `agentflow_run`/`agentflow_doctor` tools; see `.opencode/INSTALL.md` |
| Ori/OpenRouter | no plugin surface — run `agentflow` CLI directly with `--harness ori` / `--harness openrouter` or `--via ori` |

<sub>Install rows verified from a scratch HOME on 2026-10-10 against the
public repo. agentflow is not published to npm — the plugin manifests above
(or a clone + `npm link`) are the install path.</sub>

The `agents/worker.md` profile gives Devin a cheap disposable subagent
(`swe-2-*` free tier or `claude-haiku-5-5-low`) for extraction-class fan-out.

## Ops

```bash
bin/agentflow run w.mjs --detach   # background; journal keeps the record
bin/agentflow status <run-id>      # progress; 'orphaned' if the pid died
bin/agentflow stop <run-id>        # SIGTERM the journaled pid (resumable)
bin/agentflow clean [--all]        # reclaim worktrees of non-live runs (force!)
node scripts/smoke-harnesses.mjs   # reproducible live-adapter matrix
```

Ops commands are cwd-rooted — run them from the directory you ran `run`
from. `clean` force-removes worktrees (ended *and* orphaned runs): harvest
agent work first.

`agent(p, {worktree: 'auto'})` runs the call in its own `git worktree` under
`.agentflow/worktrees/` — isolates file-mutating agents from the main
checkout; `clean` reclaims them after the run ends.

## Docs

- `skills/agentflow/SKILL.md` — agent-facing guidance (installed per harness)
- `docs/plans/` — design history
- `docs/smoke-matrix.md` — live per-adapter verification results (`scripts/smoke-harnesses.mjs` reproduces)
- `docs/research/` — cross-harness landscape + orchestration economics

## Status

Early development. Adapter matrix tested versions are in `bin/agentflow doctor`
output and each adapter's source comments.
