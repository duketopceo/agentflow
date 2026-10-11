# Installing Agentflow for OpenCode

The plugin lives at `plugins/agentflow/` and ships **both** OpenCode plugin
contracts. The two OpenCode SDKs expose incompatible v2 plugin contexts, so the
two versions are **separate entrypoints** in one package — install whichever
matches your OpenCode.

| Your OpenCode | Entry | Install |
|---|---|---|
| **v1, `1.18.29+`** | `plugins/agentflow/v1.mjs` (`server()`) | `opencode plugin github:duketopceo/agentflow` |
| **v2 (`2.x`)** | `plugins/agentflow/v2.mjs` (`Plugin.define`) | `opencode plugin github:duketopceo/agentflow#main::path:plugins/agentflow` |

There is no `opencode plugin add` subcommand — the only verb is
`opencode plugin <module>`, and `add` is parsed as the module name.

The v1 entry requires `1.18.29` or newer (the release where object entrypoints
were added). On older v1 releases the `server` entry is not read.

Both entries expose the same two tools: `agentflow_run`, `agentflow_doctor`.

Requires Node.js >= 20 and `agentflow` on PATH (repo `bin/agentflow`, or
`npm link` inside the repo).

> **v2 status:** the v2 entry is exercised in the test suite (it registers both
> tools against a `ToolDomain`), but **not yet on a live v2 install** — no
> v2 CLI is published yet (latest `opencode-ai` is `1.19.0`). The v1 entry is
> verified working. After a v2 release, confirm the plugin loads and that an
> `agentflow_doctor` call returns probe output.

## Reading a run's output

`agentflow run` writes its output — phase markers, per-lane results, and the
`[agentflow] run <id>` line — to **stderr**. Both entries capture stderr and
stdout together, so `agentflow_run` returns that text to you, including the
run-id you need to `status`, `stop`, or `--resume` the run.

If `agentflow` is not on `PATH`, the tool says so explicitly rather than
reporting a bare exit code; a timeout or oversized output is likewise named.

## Skill only (minimal)

If you only want the agent-facing skill (it teaches opencode to shell out to
`agentflow run`), copy it:

```bash
mkdir -p ~/.config/opencode/skills/agentflow
cp /path/to/agentflow/skills/agentflow/SKILL.md ~/.config/opencode/skills/agentflow/SKILL.md
```

Or project-local under `.opencode/skills/agentflow/`. Restart opencode after
installing; verify `/skills` lists `agentflow` and `agentflow doctor` passes.
