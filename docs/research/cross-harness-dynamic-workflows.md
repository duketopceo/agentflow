# Research: cross-harness dynamic workflows

What Claude shipped, what exists in the open, and where agentflow sits.
Gathered 2026-10-08 from official docs, the reverse-engineered claude-code
source (Icarus603/claude-code `WorkflowTool.ts`), the Agent SDK cookbook, and
live `--help`/plugin-manager output from the CLIs installed on this machine.

## 1. The Claude reference implementation, verified

Dynamic workflows = a `Workflow` tool (alias `RunWorkflow`) that compiles a
Claude-authored JavaScript script and runs it in a **vm-sandboxed background
executor**, returning a task id immediately. Requires CLI >= 2.1.154
(`claude-agent-sdk` >= 0.2.90 bundles it); GA on paid plans, API, Bedrock,
Vertex, Foundry.

Script contract (from `WorkflowTool.ts` validation):

- Script MUST begin with `export const meta = { name, description, phases }` —
  a pure object literal, statically parsed (`metaParser.js`).
- **Determinism guard**: inline scripts containing `Date.now` (and likely
  `Math.random`-class calls) are rejected — "reject non-determinism in an
  inline script body". Keeps reruns replayable and forces volatile lookups
  through agent calls.
- Globals: `agent()`, `parallel()`, `pipeline()` + standard JS (JSON, Math,
  Array). Per-agent: clean context, session cwd, configured tool allowlist,
  optional `model` routing, optional `worktree` isolation.
- Caps: **16 concurrent** (fewer on low-CPU machines), **1000 agents per run**;
  excess work queues.
- Env: `CLAUDE_CODE_SUBAGENT_MODEL` overrides all agent models;
  `CLAUDE_CODE_WORKFLOWS=0` is the kill switch.
- Built-in: `/deep-research`. Triggers: ask for a workflow, the `ultracode`
  keyword, or `/effort ultracode`.
- Documented patterns: classifier routing, fan-out/migration, adversarial
  cross-review before reporting, multi-angle plan drafting.

## 2. The competitive landscape — the gap is *dynamic*, not orchestration

Everything below orchestrates multiple harness CLIs. **None of them let the
agent author the orchestration per task** — the differentiator agentflow
keeps.

| Project | Harnesses | Shape | Dynamic scripts? |
|---|---|---|---|
| `valpere/chorus` | claude, opencode, gemini, codex, cursor, kilo | 6-way delegation mesh: `delegate_*` MCP tools + fixed commands (`council`, `review`, `vote`, `debug`) | No — fixed patterns |
| `valianx/team-harness` | claude, codex, opencode | SDD pipeline, 12 specialist agents, human gates, file-based resume | No — static pipeline |
| `b-open-io/orchestra` | claude, grok, codex, opencode | Worker dispatch, second opinion, wave fan-out, loops | No — fixed patterns |
| `docker-agent` (PR 2796) | claude-code, codex, opencode, copilot, openclaw | YAML-declared harness-backed agents via `transfer_task`; NDJSON/JSONL/ACP protocols | No — declared teams |
| `allOwO/opencode-codex-orch` | opencode only | Specialist team (orchestrator/executor/reviewer/oracle), GPT-focused, no Claude deps | No |
| `claude-flow`, conductor | claude only | swarm/worktree fan-out | No / partial |

Conclusion: cross-harness *delegation* is crowded; cross-harness *plan-as-code*
(agent writes the orchestration) is unoccupied outside Claude Code itself.

## 3. Install reality per harness (verified on this machine)

| Harness | Plugin mechanism | agentflow surface |
|---|---|---|
| devin | `.devin-plugin/plugin.json`; `devin plugins install [owner/repo\|--local]`; **`requiredPlugins`/`optionalPlugins`/`forbiddenPlugins` auto-install** | manifest + `skills/` + `agents/` — CE linked via `optionalPlugins` |
| claude | `.claude-plugin/plugin.json` + auto-discovered `skills/` `commands/` `agents/`; marketplaces | manifest + same dirs; **native Workflow preferred inside sessions** — agentflow claude adapter is for spawning `claude -p` workers |
| codex | `codex plugin marketplace add owner/repo` + `codex plugin add name@marketplace`; `.codex-plugin/` manifest (CE convention); skills + prompts | manifest + skills; commands surface as prompts (CE converter pattern) |
| opencode | `opencode plugin <module>` — **npm package (JS/TS module)**, not a manifest; project `.opencode/` dir; commands via `~/.config/opencode/commands/*.md`; reads AGENTS.md | `.opencode/INSTALL.md` interim; a real opencode plugin would be a small TS module wrapping `bin/agentflow` |

### Ori (OpenRouter) — two integration surfaces

Ori is OpenRouter's agent launcher + native coding agent, installed here.

- **`ori code`** — Ori's own agent loop, headless-capable:
  `-p/--prompt`, `--model <openrouter-slug>` (any OR model),
  `--output text|jsonl`, `--approvals self-drive|manual`,
  `--reasoning-effort`, `--resume/--session`. Approval surface is binary:
  `manual` returns agent questions to the caller (stalls headless), so the
  adapter maps both postures to `self-drive`. → `--harness ori` adapter.
- **`ori <harness>`** — launches the real CLI with OpenRouter env injected;
  remaining args pass through untouched. Verified via `ori harness list`
  (12 launchable kinds): claude, codex, grok, opencode, hermes, omp,
  prime-agent, kilo, cline, pi, muse, dsh — `dsh` configures DeepSeek
  Harness rather than launching it, so it is excluded from `via`.
  Ori subcommand names equal binary names, so the wrap is a literal
  `['ori', ...argv]` prepend — implemented as spec `via: 'ori'` /
  CLI `--via ori`. In wrapper mode Ori **consumes `--model` and
  `--reasoning-effort` itself** and translates them to the harness's
  native mechanism — so `model:` values under `--via ori` are OpenRouter
  slugs regardless of which harness runs the worker, and
  `reasoningEffort:` works cross-harness. Workers keep their harness's
  flags and output parsing while credentials + models route through
  OpenRouter. This is the cheap-model lever: a workflow can run
  claude-harness workers on `x-ai/grok-4-fast` or `deepseek/*` without
  touching Anthropic billing.
  Caveat: recent Ori versions prompt to confirm a project-discovered key
  before first spend — headless callers must pre-approve (`ori auth` /
  `ori login --with-key` or `OPENROUTER_API_KEY`).
- **Adjacent Ori tools** (not adapters, noted for the roadmap): `ori eval`
  runs `*.eval.ts` model comparisons natively (overlaps "same task across
  models" workflows); `ori Intern`/`Desktop` are waitlisted Slack/menu-bar
  surfaces; `ori harness test` runs harness contract cases.

"One plugin for them all" is literally true only on devin (`optionalPlugins`
pulls the CE suite alongside). Elsewhere it's one repo, one install per
harness — the shared `skills/` + `workflows/` content is identical.

## 4. Fidelity gaps vs Claude native (deliberate or open)

| Claude capability | agentflow status |
|---|---|
| In-process pooled executor, background task + task id | Subprocess per `agent()` (seconds startup); foreground run, Ctrl-C -> resumable journal. `--detach` mode is an open follow-up. |
| Determinism guard (reject `Date.now`/`Math.random`/`crypto.randomUUID` in scripts) | Enforced at runtime by default — `Date`, `Math` and `crypto` are shadowed; `--allow-nondeterminism` opts out. Advisory: scripts can still reach `globalThis.Date`. |
| `meta.phases` required | Accepted and documented; not enforced. |
| Per-agent worktree | `worktree` spec field exists; honored by codex (`--worktree`); devin `-p` has no flag — local CLI gap, documented. |
| Per-agent cost/token reporting | Not surfaced — harness output formats vary. Follow-up. |
| 16-concurrency / 1000-cap | Pool is unbounded by count (default 8); no run cap. Follow-up: `--max-agents`. |
| `/deep-research` built-in | `workflows/deep-research.mjs` + `commands/deep-research.md` shipped. |

## 5. Open questions

- **opencode native plugin**: build the real npm module (tools + install) or
  keep INSTALL.md? Probably worth it once the workflow API stabilizes.
- **CE linkage depth**: `optionalPlugins` today. If the fuse goes deeper
  (ce-loop-as-workflow scripts that express plan->work->review->compound as
  `pipeline()` stages), consider `requiredPlugins` on the devin manifest.
- **Codex manifest schema**: `.codex-plugin/plugin.json` mirrors CE's
  convention; verify against codex's marketplace docs on first real install.
- **Determinism lint**: Claude's guard exists for replay fidelity — our resume
  already depends on stable call order, so a static check (`Date.now`,
  `Math.random`, unsorted `readdir`) would catch real resume bugs.

## 6. Naming

`agentflow`: free on npm (`agent-flow` is taken, 0.0.2), repo already named.
Collision: Stanford's academic AgentFlow research framework — a paper/repo,
not a packaged product in this space. Acceptable; rename cost is low (GitHub
redirects survive).
