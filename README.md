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
`log()`, `args`. `agent()` returns `{ text, json? }` or `null` on failure —
it never throws, so filter/check for null. Scripts run with your ambient
privileges (no sandbox) and static `import` is unsupported — use
`await import()`.

## CLI

```bash
agentflow run <script.mjs> [--harness devin|claude|codex|opencode|echo]
  [--concurrency N] [--dir PATH] [--run-id ID] [--resume RUN-ID]
  [--permission default|escalated] [-- script-args]
agentflow list      # recorded runs under .agentflow/runs/
agentflow doctor    # probe harness binaries + flag support
```

`--resume` replays settled `agent()` calls from the prior journal when the
call spec (prompt + options) hashes identically; changed calls and prior
failures re-execute. SIGINT drains in-flight calls and never spawns queued
ones — resume picks up where the journal left off.

Config file `agentflow.json` (see `agentflow.example.json`): `harness`,
`concurrency`, per-harness `maxConcurrency`, `permission` ceiling.

`agent()` options: `label`, `model`, `schema` (JSON Schema → `result.json`),
`worktree` (true = scratch git worktree, discarded on settle), `cwd`,
`timeout`, `permission` (clamped by run ceiling), `sandbox`.

## Harness matrix

| harness | one-shot invocation | structured output | least-privilege default |
| --- | --- | --- | --- |
| devin | `devin -p` | prompt instruction + extraction | `--permission-mode smart` |
| claude | `claude -p --output-format json` | `--json-schema` | read-only `--allowedTools` |
| codex | `codex exec` | `--output-schema` file | `-s workspace-write` |
| opencode | `opencode run --format json` | prompt instruction + extraction | no `--auto` unless escalated |

Run `agentflow doctor` to verify installed CLIs support the expected flags.

## Docs

- `skills/agentflow/SKILL.md` — agent-facing guidance (installed per harness)
- `docs/plans/` — design history

## Status

Early development. Adapter matrix tested versions are in `bin/agentflow doctor`
output and each adapter's source comments.
