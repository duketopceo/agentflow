// agentflow plugin for OpenCode **v1** (1.18.29+).
//
// V1 loads a plugin module and calls `server()`, receiving a hooks object whose
// `tool` map is built with the v1 `tool()` helper (Zod schemas). Imported from
// `@opencode-ai/plugin`.
//
// This file imports ONLY the v1 SDK. The two OpenCode SDKs expose incompatible
// v2 plugin contexts — `@opencode-ai/plugin/v2/promise` has no `tool` domain
// while `@opencode/plugin` does — so a single module importing both cannot
// serve both arms. See v2.mjs for the counterpart.
//
// Plain .mjs, not .ts: see the note in v2.mjs.
//
// Requires `agentflow` on PATH (repo bin/agentflow, or `npm link` in the repo).
import { tool } from "@opencode-ai/plugin";
import {
  RUN_DESCRIPTION, DOCTOR_DESCRIPTION, HARNESS_DESCRIPTION, VIA_DESCRIPTION,
  SCRIPT_DESCRIPTION, SCRIPT_ARGS_DESCRIPTION,
  buildRunArgs, buildDoctorArgs, runAgentflow, toolOutcome,
} from "./args.mjs";

export default {
  async server({ directory }) {
    const cwd = directory;
    return {
      tool: {
        agentflow_run: tool({
          description: RUN_DESCRIPTION,
          args: {
            script: tool.schema.string().describe(SCRIPT_DESCRIPTION),
            harness: tool.schema.string().optional().describe(HARNESS_DESCRIPTION),
            via: tool.schema.string().optional().describe(VIA_DESCRIPTION),
            scriptArgs: tool.schema.string().optional().describe(SCRIPT_ARGS_DESCRIPTION),
          },
          // Routed through the shared runAgentflow rather than v1's `$` shell
          // helper so both arms share ONE capture path. The v1 plugin that
          // shipped before read stdout only, so every successful run returned
          // "" and the caller lost the run-id — the regression these tests pin.
          //
          // A failed run THROWS (see toolOutcome) rather than returning its
          // text: neither SDK exposes an error channel in a tool result, so a
          // returned string would be recorded as a successful call.
          async execute(args) {
            const r = await runAgentflow(buildRunArgs(args), { cwd });
            return toolOutcome(r).content;
          },
        }),
        agentflow_doctor: tool({
          description: DOCTOR_DESCRIPTION,
          args: {},
          async execute() {
            const r = await runAgentflow(buildDoctorArgs(), { cwd });
            return toolOutcome(r).content;
          },
        }),
      },
    };
  },
};