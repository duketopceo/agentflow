# Task queue — serializing expensive ops across parallel agents

Worker fan-out (`src/pool.mjs`, `agents/worker.md`) runs N agents in parallel.
Left alone, each invokes builds/tests/installs freely; on memory-tight boxes
compile + agents together trigger oomd kills (see the llama.cpp services in
the machine notes). `agent-task-queue`
([block/agent-task-queue](https://github.com/block/agent-task-queue), PyPI)
is the shared chokepoint: an MCP server with SQLite FIFO queues that
serializes the expensive parts.

## Install / registration

Launched per-harness as an MCP server — no daemon, no clone:

```json
{
  "mcpServers": {
    "agent-task-queue": {
      "command": "uvx",
      "args": ["agent-task-queue@0.4.1"]
    }
  }
}
```

The version is **pinned** (`0.4.1`, exported as `TASK_QUEUE_VERSION` in
`src/taskqueue.mjs`); do not float `@latest` in registered config atoms. The
canonical atoms live in luke-agents (`scripts/mcp/` catalog) and the dotfiles
`.mcp.json` — the value multiplies when every harness (Claude, Cursor, Codex,
Devin) points at the same queue so non-agentflow sessions serialize too.

`agentflow doctor` prints a `note task-queue …` line reporting whether the
`uvx`/`uv` launcher is on PATH. It is informational only — the queue is
opt-in and never changes doctor's exit code.

## Queue topology

- `shared` — default queue for builds/tests. All workers on the machine
  serialize through it.
- `build/<worktree>` — leaf queues for stateful per-worktree work (configured
  via the server's `--queue-capacity` scopes when a shared parent cap is
  wanted). Unconfigured leaves are still independent FIFO queues.

`queue_name` is per `run_task` call, so workers opt in per command — no
global routing needed.

## Worker contract

Both worker prompts (`agents/worker.md`, `droids/worker.md`) carry the rule:
expensive commands (compilers, `npm test`, `cargo build`, `docker build`,
package installs) go through `run_task` on the `shared` queue when the tool
is available; `task_status(task_id, output_offset)` returns bounded
heartbeats mid-task instead of re-running. If the tool is absent the worker
runs the command directly — the queue must never become a hard dependency.

## Behaviour notes

- **FIFO**: strict ordering within each exact `queue_name`; queue wait time
  is unbounded (MCP holds the connection), `timeout_seconds` applies to
  execution only (default 1200s, hard auto-kill at 120min).
- **Zombie cleanup**: the server detects dead parents, kills orphaned
  children, and clears stale locks — a SIGKILLed worker leaves no orphaned
  `cargo build`.
- **Ephemeral state**: SQLite lives under `/tmp/agent-task-queue/` — queue
  state does not survive reboots. Acceptable; queues are ephemeral by nature.
- **Opt-in hole**: enforcement is cooperative. Permissive Bash rules let an
  agent bypass `run_task`; the sandboxing plan
  (`docs/plans/2026-10-19-003-eval-worker-sandboxing-plan.md`) is where
  mandatory enforcement would live.
