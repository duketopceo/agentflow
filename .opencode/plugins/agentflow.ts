import { tool } from "@opencode-ai/plugin";

// Native opencode plugin surface for agentflow: exposes the workflow runner
// as opencode tools. Install: `opencode plugin add file:<this-repo>` or drop
// this file into ~/.config/opencode/plugins/. Requires `agentflow` on PATH
// (bin/agentflow) or run `npm link` in the repo.
export const agentflow = async ({ $, directory }) => {
  const run = (args) => $`agentflow ${args}`.cwd(directory).text();
  return {
    tool: {
      agentflow_run: tool({
        description:
          "Run an agentflow dynamic-workflow script: pooled fresh-context agents across devin/claude/codex/opencode/ori. Journals to .agentflow/, resumable.",
        args: {
          script: tool.schema.string().describe("workflow script path, e.g. workflows/deep-research.mjs"),
          harness: tool.schema.string().optional().describe("devin|claude|codex|opencode|ori|openrouter|echo"),
          via: tool.schema.string().optional().describe("ori — route the harness through OpenRouter"),
          scriptArgs: tool.schema.string().optional().describe("args after --, e.g. a task or question"),
        },
        async execute(a) {
          const argv = ["run", a.script];
          if (a.harness) argv.push("--harness", a.harness);
          if (a.via) argv.push("--via", a.via);
          if (a.scriptArgs) argv.push("--", a.scriptArgs);
          return run(argv);
        },
      }),
      agentflow_doctor: tool({
        description: "Probe installed agent harnesses and flag missing binaries or drifted flags.",
        args: {},
        async execute() {
          return run(["doctor"]);
        },
      }),
    },
  };
};

export default agentflow;
