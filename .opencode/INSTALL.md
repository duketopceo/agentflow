# Installing Agentflow for OpenCode

The plugin lives at `plugins/agentflow/` and carries **both** OpenCode plugin
contracts from one package, using the dual shape the v2 migration guide
documents. Install once; it works whichever version you run.

| Your OpenCode | Which arm runs | Install |
|---|---|---|
| **v1, `1.18.29+`** | `server()` — `agentflow_run` / `agentflow_doctor` | `opencode plugin github:duketopceo/agentflow` |
| **v2 (`2.x`)** | `Plugin.define` `setup()` — same two tools | `opencode plugin add 'github:duketopceo/agentflow#main::path:plugins/agentflow'` |

The v1 arm requires `1.18.29` or newer (the release where object entrypoints
were added). On older v1 releases the `server` entry is not read.

Requires Node.js >= 20 and `agentflow` on PATH (repo `bin/agentflow`, or
`npm link` inside the repo).

> **v2 status:** the v2 arm is written against the v2 plugin docs but **not yet
> exercised on a live v2 install** — v2 is not on npm yet (latest published is
> `1.19.0`). The v1 arm above is verified working. After a v2 release, confirm
> with `opencode plugin list` and an `agentflow_doctor` call.

Tools exposed by both arms: `agentflow_run`, `agentflow_doctor`.

## Reading a run's output

The runner writes its output — phase markers, per-lane results, and the
`[agentflow] run <id>` line — to **stderr**, so both arms capture stderr and
stdout together. `agentflow_run` returns that text to you, including the run-id
you need to `status`, `stop`, or `--resume` the run.

## Skill only (minimal)

If you only want the agent-facing skill (it teaches opencode to shell out to
`agentflow run`), copy it:

```bash
mkdir -p ~/.config/opencode/skills/agentflow
cp /path/to/agentflow/skills/agentflow/SKILL.md ~/.config/opencode/skills/agentflow/SKILL.md
```

Or project-local under `.opencode/skills/agentflow/`. Restart opencode after
installing; verify `/skills` lists `agentflow` and `agentflow doctor` passes.