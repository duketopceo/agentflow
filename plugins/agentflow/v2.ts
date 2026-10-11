// agentflow plugin for OpenCode **v2** (2.x).
//
// V2 default-exports `Plugin.define({ id, setup })`; setup registers tools via
// the synchronous `ctx.tool.transform` editor (JSON Schema inputs, `{ content }`
// returns). Imported from `@opencode/plugin`.
//
// This file imports ONLY the v2 SDK — see the note in v1.ts on why the two
// SDKs cannot be merged into one module.
//
// STATUS: written against the v2 plugin docs and NOT yet exercised on a live
// v2 install — no v2 CLI is published yet (latest opencode-ai is 1.19.0). The
// only thing verifiable today is that this file loads and that setup() degrades
// quietly on a context without a `tool` domain rather than throwing at load.
//
// Requires `agentflow` on PATH (repo bin/agentflow, or `npm link` in the repo).
import { Plugin } from "@opencode/plugin";
import {
  RUN_DESCRIPTION, DOCTOR_DESCRIPTION, HARNESS_DESCRIPTION, VIA_DESCRIPTION,
  SCRIPT_DESCRIPTION, SCRIPT_ARGS_DESCRIPTION,
  buildRunArgs, buildDoctorArgs, runAgentflow,
} from "./args.mjs";

export default Plugin.define({
  id: "agentflow",
  async setup(ctx) {
    // Fail soft. A v2 build without the tool domain would otherwise throw here
    // — and because setup is awaited at load, that kills the whole plugin
    // rather than degrading it. Nothing else in this plugin depends on load.
    if (!ctx?.tool?.transform) return;

    const cwd = ctx.location.directory;
    const registration = await ctx.tool.transform((editor) => {
      editor.add({
        name: "agentflow_run",
        description: RUN_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            script: { type: "string", description: SCRIPT_DESCRIPTION },
            harness: { type: "string", description: HARNESS_DESCRIPTION },
            via: { type: "string", description: VIA_DESCRIPTION },
            scriptArgs: { type: "string", description: SCRIPT_ARGS_DESCRIPTION },
          },
          required: ["script"],
          additionalProperties: false,
        },
        async execute(input) {
          const a = input as { script: string; harness?: string; via?: string; scriptArgs?: string };
          const r = await runAgentflow(buildRunArgs(a), { cwd });
          return { content: r.out };
        },
      });
      editor.add({
        name: "agentflow_doctor",
        description: DOCTOR_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          const r = await runAgentflow(buildDoctorArgs(), { cwd });
          return { content: r.out };
        },
      });
    });
    // Retain the registration so a plugin reload disposes its transform instead
    // of stacking a second editor.add of the same two tool names.
    return () => { void registration?.dispose?.(); };
  },
});