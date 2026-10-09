# Installing Agentflow for OpenCode

## Native plugin (recommended)

This repo ships a real opencode plugin at `.opencode/plugins/agentflow.ts`
— it exposes `agentflow_run` and `agentflow_doctor` tools.

```bash
opencode plugin add file:/path/to/agentflow
# or from git:
opencode plugin add github:duketopceo/agentflow
```

Requires Node.js >= 20 and `agentflow` on PATH (repo `bin/agentflow`, or
`npm link` inside the repo).

## Skill only (minimal)

If you only want the agent-facing skill (it teaches opencode to shell out
to `agentflow run`), copy it:

```bash
mkdir -p ~/.config/opencode/skills/agentflow
cp /path/to/agentflow/skills/agentflow/SKILL.md ~/.config/opencode/skills/agentflow/SKILL.md
```

Or project-local under `.opencode/skills/agentflow/`. Restart opencode after
installing; verify `/skills` lists `agentflow` and `agentflow doctor` passes.
