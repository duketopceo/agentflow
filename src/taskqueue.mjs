// Shared task-queue probe (block/agent-task-queue).
//
// agentflow does not own the queue — it is an external MCP server launched as
// `uvx agent-task-queue@<pin>` and registered in each harness's MCP config.
// Worker fan-out (src/pool.mjs) only stops thrashing the box when the agents
// it spawns can actually reach that server, so `agentflow doctor` reports
// whether the uvx launcher is present. Detection only: the probe never fails
// doctor — the queue is opt-in per the plan's scope boundary.
import { which } from './adapters/which.mjs';

// Pinned PyPI release. Bumping requires a re-verify of the tool surface
// (run_task/task_status signatures); the MCP config atoms in luke-agents and
// dotfiles pin the same string.
export const TASK_QUEUE_VERSION = '0.4.1';
export const TASK_QUEUE_SPEC = `agent-task-queue@${TASK_QUEUE_VERSION}`;

// Launcher descriptor for docs/tests and any future spawn integration.
export function taskQueueLauncher() {
  return { command: 'uvx', args: [TASK_QUEUE_SPEC] };
}

export async function probeTaskQueue() {
  const uvx = await which('uvx');
  if (uvx) {
    return {
      available: true,
      path: uvx,
      notes: [`run_task via uvx ${TASK_QUEUE_SPEC}`],
    };
  }
  // A bare `uv` install also provides uvx-equivalent `uv tool run`; report it
  // as available with the alternate invocation noted.
  const uv = await which('uv');
  if (uv) {
    return {
      available: true,
      path: uv,
      notes: [`run_task via uv tool run ${TASK_QUEUE_SPEC}`],
    };
  }
  return {
    available: false,
    notes: ['uvx not on PATH — agent-task-queue unavailable (optional; serializes expensive ops across agents)'],
  };
}
