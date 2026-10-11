// One SDK supplies both arms. `@opencode-ai/plugin` ships the v2 Promise API
// at its `/v2/promise` subpath — the same `Plugin.define({ id, setup })` shape
// the v2 docs describe — alongside the v1 plugin-function type. Depending on
// both `@opencode-ai/plugin` and `@opencode/plugin` would make this module
// unloadable whenever either is absent, so the v1 package is the single source
// for both: `Plugin` (v2 define) and `tool` (v1 tool helper) both come from it.
import { define } from "@opencode-ai/plugin/v2/promise";
import { tool } from "@opencode-ai/plugin";
import { buildRunArgs, buildDoctorArgs, runAgentflow } from "./args.mjs";

// agentflow plugin for OpenCode — one package, two version arms.
//
// OpenCode v2 rewrote the plugin API: v1 plugins export a function returning a
// tool map, while v2 default-exports `Plugin.define({ id, setup })`. The
// migration guide documents carrying BOTH from one default export ("Support V1
// and V2 from one package"), which is what this file does — its `PluginModule`
// type is exactly `{ id?, server, tui? }`, matching the spread-plus-server shape
// below. Each arm keeps its native idiom and neither emulates the other; only
// the argv assembly and the stdout/stderr capture are shared (see args.mjs).
//
// Requires `agentflow` on PATH (repo bin/agentflow, or `npm link` in the repo).
// The runner emits on stderr — see runAgentflow for why the capture is
// combined.

// ---- v2 arm (opencode 2.x) ------------------------------------------------

const run = (argv, cwd) =>
  runAgentflow(argv, { cwd, bin: "agentflow" });

export default {
  ...define({
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
            const r = await run(buildRunArgs(a), cwd);
            return { content: r.out };
          },
        });
        editor.add({
          name: "agentflow_doctor",
          description: "Probe installed agent harnesses and flag missing binaries or drifted flags.",
          input: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            const r = await run(buildDoctorArgs(), cwd);
            return { content: r.out };
          },
        });
      });
    },
  }),

  // ---- v1 arm (opencode 1.18.29+) -----------------------------------------
  // V1 calls `server()` on the module (its PluginModule type is
  // `{ id?, server, tui? }`); V2 reads the spread `Plugin.define(...)`. We route
  // through the shared runAgentflow (execFile) rather than `$` for both arms so
  // there is exactly one capture path — a stdout-only read here is the defect
  // that shipped once already.
  async server({ directory }) {
    const cwd = directory;
    return {
      tool: {
        agentflow_run: tool({
          description:
            "Run an agentflow dynamic-workflow script: pooled fresh-context agents across devin/claude/codex/opencode/ori and direct-API adapters (openrouter/perplexity/openai/anthropic). Journals to .agentflow/, resumable.",
          args: {
            script: tool.schema.string().describe("workflow script path, e.g. workflows/deep-research.mjs"),
            harness: tool.schema.string().optional().describe("devin|claude|codex|opencode|ori|openrouter|perplexity|openai|anthropic|echo"),
            via: tool.schema.string().optional().describe("ori — route the harness through OpenRouter"),
            scriptArgs: tool.schema.string().optional().describe("args after --, e.g. a task or question"),
          },
          async execute(args) {
            const r = await run(buildRunArgs(args), cwd);
            return r.out;
          },
        }),
        agentflow_doctor: tool({
          description: "Probe installed agent harnesses and flag missing binaries or drifted flags.",
          args: {},
          async execute() {
            const r = await run(buildDoctorArgs(), cwd);
            return r.out;
          },
        }),
      },
    };
  },
};