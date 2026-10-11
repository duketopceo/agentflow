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
free), one async sonar request per item on `--harness perplexity`
(grounded, cited answers — the research surface), or first-party batch APIs
on `--harness openai`/`--harness anthropic` (~50% off, 24h window). Results
align to input order; resumable mid-poll.

## Watching a run

`agentflow watch [run-id]` renders a live per-lane view from the run journal —
spinning in-flight lanes, batch poll progress, per-call token counts, orphan
detection — on an alternate screen. Piped output falls back to `tail`-style
event lines; `status <id>` prints the same totals for scripts. Token usage
is journaled per call on harnesses that report it (devin, via `--export`)
and summed in `status`/`watch`.

## Install as an agent plugin

The repo carries a manifest for each harness; all resolve to the shared
`skills/agentflow/` directory.

| Harness | Install |
|---|---|
| Devin | `devin plugins install -y duketopceo/agentflow` (or `--local /path/to/agentflow`) — reads `.devin-plugin/`; auto-installs the compound-engineering plugin via `requiredPlugins` |
| Claude Code | `claude plugin marketplace add duketopceo/agentflow` → `.claude-plugin/` — though inside Claude, prefer the native Workflow tool |
| Codex | `codex plugin marketplace add duketopceo/agentflow` → `.codex-plugin/` |
| OpenCode | `opencode plugin github:duketopceo/agentflow` on v1 `1.18.29+`, or `opencode plugin add 'github:duketopceo/agentflow#main::path:plugins/agentflow'` on v2 — one package serves both, exposing `agentflow_run`/`agentflow_doctor`. The v2 arm is not yet exercised on a live install. See `.opencode/INSTALL.md` |
| Ori/OpenRouter/Perplexity | no plugin surface — run `agentflow` CLI directly with `--harness ori` / `--harness openrouter` / `--harness perplexity` or `--via ori` |

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
