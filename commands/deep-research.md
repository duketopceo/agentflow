---
description: Deep-research a question with a fan-out agent workflow — decompose, parallel researchers, adversarial cross-check, synthesis
---

Run agentflow's built-in deep-research workflow on: $ARGUMENTS

1. Locate the runner, first hit wins:
   - `agentflow` on PATH
   - `npx -y github:duketopceo/agentflow` (fetches the repo)
   - the plugin checkout — `devin plugins list`, or the repo you cloned
     (`node <repo>/bin/agentflow`)
2. Run it on THIS harness's adapter so workers use the same credentials:

   `agentflow run <repo>/workflows/deep-research.mjs --harness devin|claude|codex|opencode -- "$ARGUMENTS"`

   Optionally set `AGENTFLOW_CHEAP_MODEL` to route bulk stages to a cheaper model.
3. The workflow's synthesis prints to stderr at the end — report it to the
   user. If the run is interrupted, surface the `run <id>` line and offer
   `agentflow run ... --resume <id>`.

Inside Claude Code itself, prefer the native `/deep-research` workflow — this
command exists for harnesses without a built-in equivalent.
