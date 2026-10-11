# Installing Agentflow for OpenCode

Requires **OpenCode v2** (`opencode >= 2.x`) — the plugin lives at
`plugins/agentflow/` and uses `Plugin.define` + `ctx.tool.transform` from
`@opencode/plugin`. v1 plugin code is not supported.

Requires Node.js >= 20 and `agentflow` on PATH (repo `bin/agentflow`, or
`npm link` inside the repo).

```bash
# package plugin from git:
opencode plugin add 'github:duketopceo/agentflow#main::path:plugins/agentflow'

# or project-local — add to opencode.jsonc:
{ "plugins": ["/path/to/agentflow/plugins/agentflow"] }
```

Tools exposed: `agentflow_run`, `agentflow_doctor`.

**Status:** written against the v2 plugin docs — **not yet exercised on a
live v2 install** (v2 is not on npm yet; latest published is `1.19.0`).
After upgrading, verify with `opencode plugin list` and an
`agentflow_doctor` call.

## Skill only (minimal)

If you only want the agent-facing skill (it teaches opencode to shell out
to `agentflow run`), copy it:

```bash
mkdir -p ~/.config/opencode/skills/agentflow
cp /path/to/agentflow/skills/agentflow/SKILL.md ~/.config/opencode/skills/agentflow/SKILL.md
```

Or project-local under `.opencode/skills/agentflow/`. Restart opencode after
installing; verify `/skills` lists `agentflow` and `agentflow doctor` passes.
