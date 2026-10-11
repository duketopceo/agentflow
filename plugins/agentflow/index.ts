import { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";

// agentflow plugin for OpenCode v2 — requires opencode >= 2.x.
// Exposes the runner as tools: agentflow_run / agentflow_doctor.
// Requires `agentflow` on PATH (repo bin/agentflow or `npm link` in the repo).
// Written against the v2 plugin docs (Plugin.define + ctx.tool.transform);
// not yet exercised on a live v2 install.
const run = (argv: string[], cwd: string) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    execFile(
      "agentflow",
      argv,
      { cwd, timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code as number) ?? 1 : 0, out: `${stdout}${stderr}` });
      },
    );
  });

export default Plugin.define({
  id: "agentflow",
  async setup(ctx) {
    const cwd = ctx.location.directory;
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "agentflow_run",
        description:
          "Run an agentflow dynamic-workflow script: pooled fresh-context agents across devin/claude/codex/opencode/ori and direct-API adapters (openrouter/perplexity/openai/anthropic). Journals to .agentflow/, resumable.",
        input: {
          type: "object",
          properties: {
            script: { type: "string", description: "workflow script path, e.g. workflows/deep-research.mjs" },
            harness: { type: "string", description: "devin|claude|codex|opencode|ori|openrouter|perplexity|openai|anthropic|echo" },
            via: { type: "string", description: "ori — route the harness through OpenRouter" },
            scriptArgs: { type: "string", description: "args after --, e.g. a task or question" },
          },
          required: ["script"],
          additionalProperties: false,
        },
        async execute(input) {
          const a = input as { script: string; harness?: string; via?: string; scriptArgs?: string };
          const argv = ["run", a.script];
          if (a.harness) argv.push("--harness", a.harness);
          if (a.via) argv.push("--via", a.via);
          if (a.scriptArgs) argv.push("--", a.scriptArgs);
          const r = await run(argv, cwd);
          return { content: r.out || `agentflow exited ${r.code}` };
        },
      });
      editor.add({
        name: "agentflow_doctor",
        description: "Probe installed agent harnesses and flag missing binaries or drifted flags.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          const r = await run(["doctor"], cwd);
          return { content: r.out || `agentflow exited ${r.code}` };
        },
      });
    });
  },
});
