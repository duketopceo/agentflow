# Installing Agentflow for OpenCode

OpenCode discovers skills from `~/.config/opencode/skills/<name>/SKILL.md`
(user-level) or `<project>/.opencode/skills/` (project-level), depending on
version. The reliable path today is a direct copy:

```bash
mkdir -p ~/.config/opencode/skills/agentflow
cp /path/to/agentflow/skills/agentflow/SKILL.md ~/.config/opencode/skills/agentflow/SKILL.md
```

Or project-local:

```bash
mkdir -p .opencode/skills/agentflow
cp /path/to/agentflow/skills/agentflow/SKILL.md .opencode/skills/agentflow/SKILL.md
```

Restart OpenCode after copying. The skill itself is harness-agnostic — it
teaches the agent to shell out to `agentflow run`, which uses the `opencode`
adapter (`opencode run --format json`).

Alternatively, add this repo to the `plugin` array in `opencode.json` so
OpenCode loads the package; skill discovery from package form varies by
OpenCode version — verify `/skills` lists `agentflow` after install.

The runner itself needs Node.js >= 20 on PATH.
