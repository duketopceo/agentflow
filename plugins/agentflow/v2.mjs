// agentflow plugin for OpenCode **v2** (2.x).
//
// V2 default-exports `Plugin.define({ id, setup })`; setup registers tools via
// the synchronous `ctx.tool.transform` editor (JSON Schema inputs, `{ content }`
// returns). Imported from `@opencode/plugin`.
//
// This file imports ONLY the v2 SDK — see the note in v1.mjs on why the two
// SDKs cannot be merged into one module.
//
// Plain .mjs, not .ts: OpenCode loads this file, and Node 20 (a supported
// runtime, and a CI leg) cannot import .ts at all. Plain JS keeps the whole
// matrix green and the `engines` floor honest.
//
// STATUS: exercised in the test suite (setup registers both tools against a
// ToolDomain, and degrades quietly on a context without one) but NOT yet on a
// live v2 install — no v2 CLI is published yet (latest opencode-ai is 1.19.0).
//
// Requires `agentflow` on PATH (repo bin/agentflow, or `npm link` in the repo).
import { Plugin } from "@opencode/plugin";
import {
  RUN_DESCRIPTION, DOCTOR_DESCRIPTION, HARNESS_DESCRIPTION, VIA_DESCRIPTION,
  SCRIPT_DESCRIPTION, SCRIPT_ARGS_DESCRIPTION,
  buildRunArgs, buildDoctorArgs, runAgentflow, toolOutcome,
} from "./args.mjs";

export default Plugin.define({
  id: "agentflow",
  async setup(ctx) {
    // Fail soft, but loudly enough to diagnose. A host without a tool domain
    // would otherwise throw here, and because setup is awaited at load that
    // kills the whole plugin. Returning silently would leave an operator
    // staring at a missing tool with no explanation, so log the cause.
    if (!ctx?.tool?.transform) {
      console.error("[agentflow] v2 plugin context has no tool domain — tools not registered");
      return;
    }

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
          const r = await runAgentflow(buildRunArgs(input), { cwd });
          return toolOutcome(r);
        },
      });
      editor.add({
        name: "agentflow_doctor",
        description: DOCTOR_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          const r = await runAgentflow(buildDoctorArgs(), { cwd });
          return toolOutcome(r);
        },
      });
    });
    // Retain the registration so a plugin reload disposes its transform instead
    // of stacking a second editor.add of the same two tool names. Returning the
    // promise lets the host await teardown; dropping it would surface a
    // rejecting dispose as an unhandled rejection.
    return () => registration.dispose();
  },
});