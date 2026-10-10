---
name: agentflow
description: Fan out work to many agents via a workflow script — parallel subagent orchestration with journaled results and resume. Use when a task needs >4 independent agent calls, staged phases with aggregation, or results too large to keep in your own context.
---

# Agentflow — script-driven multi-agent orchestration

You orchestrate turn-by-turn by default: every subagent result lands in your
context window. Agentflow moves the loop, branching, and intermediate results
into a JavaScript file that a runner executes — you keep only the final answer.

## When to use

- Fan-out beyond ~4 independent agent calls (file-per-file reviews, repo-wide
  audits, per-endpoint checks, N-variant drafting).
- Staged pipelines where later phases consume earlier results.
- Runs you may need to interrupt and resume.
- Results are bulky: the script holds them; you read the synthesis.

## When NOT to use

- 1-4 subagent calls — just use your harness's native subagent tool; a CLI
  session per call has real startup cost, so keep fan-out granularity
  meaningful (a whole file audit, not a function rename).
- Anything needing shared state, locks, or transactions between agents —
  workflow agents share nothing but the filesystem.
- Claude Code's **native** Workflow tool (ultracode/`/deep-research`) — inside
  Claude sessions, prefer it; it is faster and cheaper than spawning `claude -p`.

## How it works

```bash
agentflow run workflow.mjs --harness devin --concurrency 8
agentflow run workflow.mjs --resume <run-id>   # after interrupt
agentflow doctor                             # check harness availability
```

Each `agent()` call spawns one **non-interactive CLI session** of the selected
harness as a subprocess, in a fresh context, and resolves to `{text, json}` or
`null` on failure. Calls queue under a bounded concurrency pool (default 8).
Every settled call is journaled to `.agentflow/runs/<run-id>.jsonl`; `--resume`
replays settled results and re-runs only what never finished.

## Workflow script contract

`.mjs` file, top-level `await` allowed, globals injected:

| Global | Signature | Notes |
|---|---|---|
| `agent` | `(prompt, opts?) => Promise<{text, json} \| null>` | opts: `label`, `model`, `schema`, `worktree`, `cwd`, `timeout` (ms), `permission` |
| `parallel` | `(thunks) => Promise<results>` | `parallel(files.map(f => () => agent(...)))` — order preserved, `null` per failure |
| `pipeline` | `(items, ...stages) => Promise<results>` | each item flows through stages; `null` short-circuits that item |
| `phase` | `(name) => void` | labels stderr progress |
| `log` | `(msg) => void` | stderr; keep secrets out |
| `args` | array | args after `--` on the CLI |
| `meta` | object | from `export const meta = {...}` |

Constraints:

- `export const meta = { name, description, phases }` is the only export; it
  must be a **plain object literal**. `phases` is an array of phase-name
  strings matching your `phase()` calls (parity with Claude's native contract).
- No static `import`/`export` — scripts are self-contained. Dynamic
  `await import('node:fs')` works.
- Determinism is your job: resume replays by call order, so keep `agent()`
  call order stable across runs (don't drive call order off `Date.now()` or
  unordered directory listings).

## Per-harness adapter table

| `--harness` | Spawns | `model` | `schema` | `worktree` | `permission: 'escalated'` |
|---|---|---|---|---|---|
| `devin` (default) | `devin -p` | `--model` (e.g. `claude-haiku-5-5-low`, `adaptive`) | prompt-level JSON instruction | planned | `dangerous` |
| `claude` | `claude -p --output-format json` | `--model` | prompt-level | no | `bypassPermissions` |
| `codex` | `codex exec` | `-m` | native `--output-schema` | `--worktree` | `--dangerously-bypass-approvals-and-sandbox` |
| `opencode` | `opencode run --format json` | `-m provider/model` | prompt-level | no | `--auto` |
| `ori` | `ori code -p` | `--model <openrouter-slug>` — any model on OpenRouter | prompt-level | no | `self-drive` (binary approval surface; `manual` stalls headless) |
| `openrouter` | in-process `POST /chat/completions` — **no subprocess, no tools** | OR slug (default `z-ai/glm-5.3-flash`) | prompt-level | n/a | n/a — needs `OPENROUTER_API_KEY` in env |
| `echo` | none (test adapter) | — | canned | — | — |

`openrouter` is the cheapest surface — use it for tool-free stages
(decompose, classify, verify prose, synthesize); harness adapters only where
agents need the filesystem. `:batch` slugs do NOT work (separate async API).

**`--via ori`** wraps workers in Ori's OpenRouter environment
(`ori claude -p ...`) — the harness keeps its own flags and parsing, but
credentials and `model:` values route through OpenRouter (`model:
'x-ai/grok-4-fast'`, `deepseek/...`, etc.). Ori consumes `--model` and
`--reasoning-effort` itself in wrapper mode — `agent(..., {
reasoningEffort: 'high' })` translates to the harness's native mechanism.
Wrappable harnesses: claude, codex, opencode, grok, kilo, hermes, cline, pi,
muse, omp, prime-agent — no devin launcher exists. Requires `ori` on PATH;
`--via` on the CLI or `via: 'ori'` in `agentflow.json` applies to every
`agent()` call; a call can opt out with `via: 'direct'`.

Default permission postures are least-privilege (`smart` devin / `auto` claude /
`workspace-write` codex / none opencode). Headless agents that hit an approval
prompt fail with `permissionDenied` journaled — prefer widening the prompt or
`permission: 'escalated'` over re-running blindly.

## Cost discipline

Every harness `agent()` is a full session — real tokens plus seconds of
startup; `openrouter` adapter calls are a single completion (~$0.01–0.05).
Measured numbers and per-model tables: `docs/research/orchestration-economics.md`.
Prefer cheap models for extraction/verification volume
(`z-ai/glm-5.3-flash`, `openai/gpt-6-luna`, `deepseek/deepseek-v4.1-flash`,
`claude-haiku-5-5-low` on devin which is ~$0.10/$0.50, free `swe-2-*`) and
reserve strong models for the synthesis call. Worker tier × N dominates —
orchestrator price barely matters. `--cache` memoizes identical calls
content-keyed across reruns; the research says: fan out on parallelizable
sub-questions, always end in centralized synthesis/verification
(independent agents amplify errors ~17×), and don't fan out sequential work.

**Guards:** `--strict` rejects scripts using `Date.now`, `Math.random`,
`new Date`, or `crypto.randomUUID` in the body (line-numbered errors, before
any agent spawns) — nondeterminism silently misaligns `--resume`'s positional
replay. `--max-agents <n>` (default 1000) caps total `agent()` calls per run.
`--retries <n>` (default 0) re-runs transient failures — cheap models flake on
empty completions under burst; `agent(p, {retries: 2})` for volume stages.
Never retried: `permissionDenied` and `timedOut`. All three settable in
`agentflow.json` (`"strict": true`, `"maxAgents": 200`, `"retries": 1`).

## Safety

**A workflow script is arbitrary code that spawns credentialed agents.** Never
`agentflow run` a script you have not read — treat it like `curl | sh` with a
sandboxed subprocess per line. The runner inherits your harness credentials and
workspace permissions. Keep `.agentflow/` out of git (it is gitignored here;
journals contain prompt and result text).

## Authoring workflows (the point of the feature)

When a task fits "When to use", **you write the script** — the orchestration
plan is code you author, the runner just executes it. The workflow:

1. Decompose the task into independent units an agent can do in one session.
2. Decide phases: what runs in parallel, what waits, what verifies.
3. Choose models per stage — cheap model for extraction/verification volume,
   default/strong model only for synthesis or hard judgment.
4. Write the `.mjs` to scratch (`.agentflow/workflows/` or `/tmp`), show it to
   the user before running — the untrusted-script rule applies to scripts you
   write too.
5. Run it, report the synthesis, keep the journal's `run <id>` for resume.

Proven composition patterns (mirror Claude's own):

- **Classifier routing**: one agent classifies each item, routes to a
  specialized follow-up agent per class.
- **Fan-out + adversarial verify**: every researcher's finding gets a separate
  verifier agent before it reaches synthesis (see `workflows/deep-research.mjs`).
- **Compound loop**: plan -> work -> review -> compound as staged agents —
  `workflows/compound-loop.mjs` runs the compound-engineering loop; each
  stage is a fresh-context agent sharing cwd (needs the CE plugin installed).
- **Multi-angle drafting**: N agents draft the same plan/spec from different
  stated angles; a judge agent weighs them.
- **Map-reduce migration**: per-file transforms in parallel, then a sweep
  agent checks integration points the per-file view can't see.

## Minimal pattern

```js
export const meta = { name: 'audit', description: 'per-file review', phases: ['fan-out', 'synthesize'] };

phase('fan-out');
const reviews = await parallel(files.map(f => () =>
  agent(`Review ${f}`, { label: `rev:${f}`, model: 'claude-haiku-5-5-low' })
));

phase('synthesize');
const ok = reviews.filter(Boolean);      // nulls = failed agents, keep count
const summary = await agent(`Synthesize:\n${ok.map(r => r.text).join('\n')}`,
  { label: 'synthesis' });
log(summary?.text ?? 'synthesis failed');
```

See `examples/parallel-audit.mjs` for a complete script.
