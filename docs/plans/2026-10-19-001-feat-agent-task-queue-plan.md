---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan user-directed
external_source: block/agent-task-queue (github.com/block/agent-task-queue) — 73★, Apache-2.0, Python/PyPI, pushed 2026-10-19
---

# agent-task-queue — serialize expensive ops across parallel agents

## Goal Capsule

Adopt Block's `agent-task-queue` MCP server as the shared chokepoint for expensive operations (builds, test runs, heavy installs) so parallel agentflow workers and concurrent agent sessions stop thrashing the M1 Max — the same pressure that gets `llama-*.service` killed by oomd.

## Product Contract

### The problem

Worker fan-out (`src/pool.mjs`, `agents/worker.md`) can run N agents in parallel, and each may invoke builds/tests freely. On this box, compile + agents together trigger memory pressure → systemd-oomd kills the llama.cpp services (documented known problem). There is no admission control on expensive commands.

### What the tool is

MCP server, `uvx agent-task-queue@latest`. SQLite FIFO queues; `run_task(command, working_directory, queue_name)`; `task_status(task_id, output_offset)` with 30s bounded heartbeats; hierarchical queues (`build/main` exclusive leaves under a shared root); zombie detection kills orphaned children; 120min auto-kill; `--queue-capacity` scopes.

### Scope boundaries

- **In:** install, register in canonical MCP map (dotfiles `.mcp.json` atoms + luke-agents catalog), point agentflow worker builds/tests at a named queue, verify heartbeats + zombie cleanup.
- **Out:** making it *mandatory*. It's a coordination primitive — agents opt in by calling the tool. Enforcement would need the sandboxing plan (separate).
- **Out:** scheduling semantics it doesn't have (priorities, deadlines).

### Requirements

1. Install: `uvx agent-task-queue@latest` — pin a version in the MCP config atom (don't float latest).
2. Queue topology: `shared` root queue for builds/tests; per-worktree leaf queues for anything stateful (`build/<worktree>`).
3. agentflow worker prompt/tool guidance (`agents/worker.md` or the worker spawn path in `src/pool.mjs`): expensive commands (compile/test/install) go through `run_task` on the shared queue.
4. Register in the canonical catalog atom (luke-agents `scripts/mcp/` map) so all harnesses can use it — the value multiplies when Claude/Cursor/Codex sessions share the same queue.
5. Zombie behavior verified: kill a worker mid-task → queued task's process tree dies, queue drains.

### Acceptance examples

- Two concurrent workers both invoke builds → serialized on the queue, second queues instead of racing.
- `task_status` heartbeat returns output offsets mid-build without re-running.
- A killed worker leaves no orphaned `cargo build`/`npm test` processes.

## Repo Touchpoints

- `agents/worker.md`, `droids/worker.md` — worker prompt gets the queue rule
- `src/pool.mjs` — if worker spawn needs to advertise the queue tool
- `docs/` — note in the run/ops docs
- External: luke-agents MCP catalog atom + dotfiles `.mcp.json` entries (committed there, not here)

## Test Scenarios

1. Two queued builds serialize; wall-clock shows no overlap.
2. Heartbeat during a 60s build returns incremental output.
3. Worker SIGKILL mid-task → orphan cleanup, next task starts clean.
4. Non-agent callers (a manual `run_task`) share the same queue as agents.

## Risks / Honest Notes

- Opt-in enforcement is the known hole (upstream README calls this out: permissive Bash rules bypass it). It reduces thrash for cooperative agents only.
- SQLite in /tmp — queue state doesn't survive reboots. Acceptable (queues are ephemeral by nature), but note it.
- 73★, young project. The blast radius is small — worst case, agents route around it and we're no worse than today.
