# agentflow for OpenCode

OpenCode has no plugin manifest; install the skill and CLI directly.

## Install

```bash
git clone https://github.com/duketopceo/agentflow
cd agentflow
# Make the CLI available:
ln -s "$PWD/bin/agentflow" ~/.local/bin/agentflow   # or anywhere on PATH

# Install the skill for opencode:
mkdir -p ~/.config/opencode/skills
ln -s "$PWD/skills/agentflow" ~/.config/opencode/skills/agentflow
```

## Verify

```bash
agentflow doctor          # probe harness CLIs
agentflow run examples/parallel-audit.mjs --harness echo
```

## Use

In an opencode session, ask for a parallel workflow — the `agentflow` skill
tells the agent to write a script and run it via `agentflow run`. To fan out
opencode itself as the leaf harness:

```bash
agentflow run my-workflow.mjs --harness opencode
```

Requires opencode CLI on PATH (`agentflow doctor` verifies `run --format json` support).
