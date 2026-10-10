# Landscape: who else orchestrates agents, and where agentflow sits

Gathered 2026-10-10. Sources are fetched pages or `gh api` lookups made that
day (URLs inline). Claims about agentflow come from the code at `origin/main`
(`eb5ef35`) and the two open PRs (#7, #8), not from the README. This extends,
and in places corrects, `cross-harness-dynamic-workflows.md` (2026-10-08) and
`orchestration-economics.md` (2026-10-09).

## 1. What "cross-harness" means in this code

It is narrower and more concrete than the marketing sentence suggests.

- A **harness** is an agent CLI that can run one prompt non-interactively:
  `devin -p`, `claude -p`, `codex exec`, `opencode run`, `ori code -p`
  (`src/adapters/*.mjs`). One more adapter, `openrouter`, is not a harness at
  all: an in-process `POST /chat/completions` with no tools; `echo` is a test
  stub.
- The **adapter contract** is small: `buildArgv(spec)`, `parse(result, spec)`,
  optional `buildEnv`, `permissionDeniedPatterns`, `probe()`, and an optional
  `spawnAgent` override (`src/adapters/base.mjs`). `spawnAgent` spawns the
  process with `stdio: ['ignore', ...]`, enforces timeout and abort, and
  classifies failure.
- The **portable unit is the workflow script**: one `.mjs` file using the
  globals `agent / parallel / pipeline / phase / log / args`. The same file
  runs under any adapter, selected by `--harness`. `agent()` resolves to
  `{text, json}` or `null`, so scripts are harness-neutral by construction.
- **Per-harness normalisation** is where the work is: permission modes map to
  each CLI's flag (`escalated` becomes `bypassPermissions` for claude,
  `--dangerously-bypass-approvals-and-sandbox` for codex); `schema` is native
  only on codex (`--output-schema`) and prompt-level elsewhere; `worktree` is
  native on codex only until PR #8 adds a runner-provisioned `'auto'` mode.
- **`--via ori`** is a second axis: the same harness binary is wrapped as
  `ori <harness>` so model routing and billing go through OpenRouter
  (`applyVia`). This makes `claude`/`codex`/`opencode` workers runnable on
  non-Anthropic/OpenAI models. Not available for `devin`.
- Not cross-harness: sessions, tool permissions, MCP config and context are
  not shared. Workers share only the filesystem (the SKILL.md says so). The
  coordination substrate is the journal (`.agentflow/runs/<id>.jsonl`), not a
  protocol like ACP or A2A.
- Verified by use, not just code: the 2026-10-09 live matrix
  (`docs/smoke-matrix.md`) got `PONG` from all six real rows, and the matrix
  found a real bug (codex bypassing `applyVia`).

So: "cross-harness" = *one script, a thin per-CLI argv/parse adapter, and an
optional OpenRouter wrapper*. That is the whole claim, and it is a real one.

## 2. Comparable systems

| System | What it is | Better than agentflow | Worse / different | Source |
|---|---|---|---|---|
| **Claude Code dynamic workflows** | A JS script Claude writes; a runtime executes it in the background. `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`. | In-process runtime (no CLI startup per agent), progress UI (`/workflows`), pause/stop/restart per agent, 16 concurrent / 1000 per run, prompt-cache staggering across a fan-out, structured-output validation with up to 5 retries, usage-limit waits, `Date.now`/`Math.random` throw at runtime, saved workflows become `/commands`, plugins can ship `workflows/`. | Claude-only models/harness; no `import()`; no mid-run input; resume only in the same session; failed agent reruns every agent after it. | https://code.claude.com/docs/en/workflows |
| **LangGraph** (MIT, ~43k stars) | Low-level framework for stateful long-running agents; durable execution, human-in-the-loop state editing, memory, LangSmith tracing. | Persistent state, state editing mid-run, hosted deployment, tracing ecosystem. | Python, graph-as-API (the *developer* writes the graph; the agent does not author it per task), no binding to coding-agent CLIs. | https://github.com/langchain-ai/langgraph |
| **CrewAI** (MIT, ~60k stars) | Python framework: role-based *Crews* plus event-driven *Flows*; checkpointing, MCP/A2A, commercial AMP control plane. | Role abstractions, memory, enterprise tier, huge community. | Own agent loop, not your harness; static teams/flows. | https://github.com/crewAIInc/crewAI |
| **Temporal** (MIT) | Durable execution engine: workflow code replays against an Event History; activities hold I/O, so results are not re-executed. | The gold standard for the idea agentflow approximates: replay + determinism rules + activity separation. Multi-language, years-long runs. | Needs a server cluster; LLM calls are your problem; no agent concept. Agentflow's resume is the same idea in 69 lines of JSONL. | https://docs.temporal.io/workflows |
| **OpenAI Agents SDK** (MIT, ~30k stars) | Python SDK: agents, handoffs, guardrails, sessions, built-in tracing; provider-agnostic (Responses and Chat Completions, "100+ other LLMs"). | Guardrails, tracing, sessions, handoff semantics. | Orchestration is model-driven handoffs or developer code, not a replayable script; no coding-CLI workers. | https://github.com/openai/openai-agents-python |
| **Pydantic AI** (MIT) | Typed Python agent SDK; attaches Temporal, DBOS or Prefect for durable execution so each model/tool call becomes a durable activity. | Typed outputs, real durability backends. | Python; wraps model APIs, not agent CLIs. | https://github.com/pydantic/pydantic-ai |
| **Cross-harness delegation plugins** (`valpere/chorus`, MIT, 10 stars; `valianx/team-harness`, MIT, 3 stars) | Fixed patterns (council, review, vote, SDD pipeline) that delegate between claude/codex/opencode/gemini. | Ready-made patterns and, for chorus, MCP delegation tools. | Fixed patterns, not agent-authored scripts. Small, young projects. | https://github.com/valpere/chorus, https://github.com/valianx/team-harness |
| **ruflo** (formerly claude-flow, MIT, ~74k stars) | Swarm / agent-harness platform with memory, federation, native Claude Code/Codex integration. | Reach, a large feature surface. | Heavy platform vs a 2k-line runner; the opposite design philosophy. | https://github.com/ruvnet/ruflo |

Not re-verified today: `b-open-io/orchestra` (the repo path 404s from the
GitHub API; it may have been renamed) and `docker-agent` PR 2796 from the
2026-10-08 doc. Treat those two rows there as stale.

## 3. What users expect (from the comparables)

1. **Resume that does not redo finished work.** Temporal replays from history;
   Claude replays by prompt order and reruns from the first differing prompt.
   Agentflow replays by call index only (`runtime.mjs`: `prior.settled.has(i)`),
   with no prompt check, so an edited script silently reuses stale results.
   This is the biggest correctness gap against expectation.
2. **A way to watch a run.** Claude has `/workflows`; LangGraph has LangSmith.
   Agentflow has `status` and `tail` (a journal poller) and `--detach`.
3. **Determinism enforced, not advised.** Temporal and Claude both enforce it.
   Agentflow has an opt-in regex lint (`--strict`) that can be bypassed.
4. **Structured output that is validated.** Claude retries up to five times on
   a schema failure. Agentflow only asks for JSON in the prompt and extracts it
   (`extractJson`); codex alone uses a native schema flag.
5. **Cost and token visibility.** Claude shows per-agent token use; agentflow
   journals elapsed time and model but no usage.
6. **Safe-by-default permissions and an escape hatch.** Already modelled in
   agentflow's `permission: 'escalated'`.
7. **Saved/shareable workflows.** Claude: `.claude/workflows/` and plugin
   `workflows/`. Agentflow: `workflows/` in the repo and a skill.

## 4. What is unique here

- **Portability across CLIs with a real adapter layer.** None of the Python
  frameworks run `devin`, `claude`, `codex` and `opencode` as workers.
- **OpenRouter as a cost lever on top of any CLI** (`--via ori`), plus an
  in-process `openrouter` adapter for tool-free stages. The economics doc
  estimates ~$0.30 for a 20-agent deep-research on a cheap model; the live run
  cost ~$0.003 for a 12-call run.
- **Claude's script contract, reimplemented.** Scripts use the same globals
  and `meta` literal as Claude's native workflows, so a script is a candidate
  to run in both places. This is true for the globals but not yet for `return`
  values, structured `args`, or `stallMs` (see ROADMAP U4).
- **Small enough to read:** about 1,100 lines of runtime and adapters, one
  runtime dependency (`@opencode-ai/plugin`, used only by the opencode plugin).
- **Honest provenance:** a smoke matrix, a solutions folder with invariants,
  and a journal that is plain JSONL.

Where it is weak: no UI beyond `tail`, no per-agent usage numbers, no sandbox
(subprocess permissions are whatever each CLI grants), and no hosted or
multi-machine story. Those are deliberate for a local runner, but they shape
the roadmap.

## 5. Corrections to earlier docs

- `cross-harness-dynamic-workflows.md` §4 lists `--detach`, `--max-agents` and
  `--strict` as open. They shipped (v0.2, PR #6). The opencode native plugin
  (`.opencode/plugins/agentflow.ts`) also exists, so §5's first open question
  is closed.
- PR #7's M7 plan assumes the repo is private. `gh api repos/duketopceo/agentflow`
  reports `visibility: public` today, so that gate has already been passed.
- Claude's runtime now makes `Date.now`, `Math.random` and no-argument
  `new Date()` throw inside scripts, and ships a `/workflow-authoring` skill.
  Both are worth mirroring.
