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
| Devin | `devin plugins install --local /path/to/agentflow` (reads `.devin-plugin/`) |
| Claude Code | symlink or copy into your plugin dir; `.claude-plugin/plugin.json` present — though inside Claude, prefer the native Workflow tool |
| Codex | `.codex-plugin/plugin.json` present; copy `skills/agentflow/` to `$CODEX_HOME/skills/` |
| OpenCode | see `.opencode/INSTALL.md` — copy `skills/agentflow/` to `~/.config/opencode/skills/` |

The `agents/worker.md` profile gives Devin a cheap disposable subagent
(`claude-haiku-5-5-low`) for extraction-class fan-out.

## Docs

- `skills/agentflow/SKILL.md` — agent-facing guidance (installed per harness)
- `docs/plans/` — design history

## Status

Early development. Adapter matrix tested versions are in `bin/agentflow doctor`
output and each adapter's source comments.
