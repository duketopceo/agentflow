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
Every settled call is journaled to `.agentflow/runs/<run-id>.jsonl` with a
fingerprint of its prompt/model/schema/context; `--resume` replays records
whose fingerprint still matches and re-executes only what never finished or
changed since the run (logs `replay miss [i]` — stale results can't surface).

## Workflow script contract

`.mjs` file, top-level `await` allowed, globals injected:

| Global | Signature | Notes |
|---|---|---|
| `agent` | `(prompt, opts?) => Promise<{text, json, usage?} \| null>` | opts: `label`, `model`, `schema`, `worktree`, `cwd`, `timeout` (ms), `permission`, `retries`, `schemaRetries`. With `schema`, the parsed JSON is validated against a JSON Schema subset and re-prompted with the error up to `schemaRetries` times (default 4, so 5 attempts total). `usage` is `{promptTokens, completionTokens, cachedTokens, steps}` when the harness reports it — **devin only** today (from `--export` final_metrics); also journaled and summed by `status`/`watch` |
| `parallel` | `(thunks) => Promise<results>` | `parallel(files.map(f => () => agent(...)))` — order preserved, `null` per failure |
| `pipeline` | `(items, ...stages) => Promise<results>` | each item flows through stages; `null` short-circuits that item |
| `batch` | `(items, opts?) => Promise<results>` | async fan-out on **openrouter** (one OR Batch job per N prompts, ~40–60% off, ≤24h window), **devin** (N cloud sessions — `devin_mode` model, `structured_output` collected; swe-2 models are free), **perplexity** (N `/v1/async/sonar` requests — async accepts **`sonar-deep-research` only**), **openai** (Batches API, ~50% off, 24h) or **anthropic** (Message Batches, ~50% off, 24h). Items: `{prompt, label?, model?, schema?, maxTokens?}`; all share ONE model (`opts.model` or per-item). opts: `batchPollMs` (15s), `batchTimeoutMs` (2h). Results align to input order; each item consumes a normal call index |
| `phase` | `(name) => void` | labels stderr progress; journaled so `watch`/`tail` group lanes by phase |
| `log` | `(msg) => void` | stderr; keep secrets out |
| `args` | any | string array after `--` on the CLI, or parsed JSON via `--args-json` (e.g. `--args-json '{"task":"x","n":3}'` — Claude-parity structured args) |
| `cwd` | string | the run's working directory (matches `--cwd` default) — use for `node:fs` paths in scripts |
| `meta` | object | from `export const meta = {...}` |

Script ends with `return <value>` → the value prints on **stdout** (progress
stays stderr, so `agentflow run w.mjs > out.json` composes) and is journaled
on `run-end`. `process.exit(code)` inside a script ends the *script* with
that code — it can never kill the runner (Claude's sandbox parity).
Claude-parity gap: `stallMs` (inactivity timeout per agent) isn't implemented —
`timeout` is a hard wall-clock kill, the documented subset is `return` +
`args` + `process.exit`.

Constraints:

- `export const meta = { name, description, phases }` is the only export; it
  must be a **plain object literal**. `phases` is an array of phase-name
  strings matching your `phase()` calls (parity with Claude's native contract).
- No static `import`/`export` — scripts are self-contained. Dynamic
  `await import('node:fs')` works.
- Determinism is your job: the fingerprint guard stops stale results from
  replaying, but reordered/inserted calls still cascade re-executions — keep
  `agent()` call order stable across runs (don't drive it off `Date.now()`
  or unordered directory listings).

## Per-harness adapter table

| `--harness` | Spawns | `model` | `schema` | `worktree` | `permission: 'escalated'` |
|---|---|---|---|---|---|
| `devin` (default) | `devin -p` | `--model` (e.g. `claude-haiku-5-5-low`, `adaptive`) | prompt-level JSON instruction | planned | `dangerous` |
| `claude` | `claude -p --output-format json` | `--model` | prompt-level | no | `bypassPermissions` |
| `codex` | `codex exec` | `-m` | native `--output-schema` | `--worktree` | `--dangerously-bypass-approvals-and-sandbox` |
| `opencode` | `opencode run --format json` | `-m provider/model` | prompt-level | no | `--auto` |
| `ori` | `ori code -p` | `--model <openrouter-slug>` — any model on OpenRouter | prompt-level | no | `self-drive` (binary approval surface; `manual` stalls headless) |
| `openrouter` | in-process `POST /chat/completions` — **no subprocess, no tools** | OR slug (default `z-ai/glm-5.3-flash`) | prompt-level | n/a | n/a — needs `OPENROUTER_API_KEY` in env |
| `perplexity` | in-process `POST /chat/completions` — grounded answers + `citations` | `sonar` (default), `sonar-pro`; **batch: `sonar-deep-research` only** | prompt-level | n/a | n/a — needs `PERPLEXITY_API_KEY` in env |
| `openai` | in-process `POST /v1/chat/completions` — **no subprocess, no tools** | OpenAI slug (default `gpt-4.1-mini`) | prompt-level | n/a | n/a — needs `OPENAI_API_KEY` in env |
| `anthropic` | in-process `POST /v1/messages` — **no subprocess, no tools** | Anthropic slug (default `claude-haiku-4-5`) | prompt-level | n/a | n/a — needs `ANTHROPIC_API_KEY` in env |
| `echo` | none (test adapter) | — | canned | — | — |

`openrouter` is the cheapest surface — use it for tool-free stages
(decompose, classify, verify prose, synthesize); harness adapters only where
agents need the filesystem. For latency-tolerant volume, `batch(items)`
runs the harness's async-jobs surface instead of N sync calls — the run
polls until done (interrupt mid-poll is safe: `--resume` re-polls the same
journaled ids, never resubmits). On openrouter that's one `/batches` job
(model must be batch-capable); on devin it's one Cloud session per item
(`structured_output` is the result channel, sessions idle at
`waiting_for_user` once produced — that is the completion signal); on
perplexity it's one async sonar request per item (`COMPLETED` + `response`
— grounded answers carry `citations` through to the result); on
openai it's a JSONL file upload + one `/v1/batches` job; on anthropic one
`/v1/messages/batches` call (`max_tokens` required — default 8192, per-item
`maxTokens` overrides).

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

**`worktree: 'auto'`** gives the call its own git checkout — the runner runs
`git worktree add --detach` under `.agentflow/worktrees/` and sets that call's
`cwd` there (journaled as a `worktree` record). Use it when file-mutating
agents would collide in one checkout. `'auto'` is runner-owned and consumed
before the adapter sees the spec; `worktree: true` still passes through to
adapter-native flags (codex `--worktree`). Worktrees deliberately persist
after the run — `agentflow clean` reclaims them for ended runs (`--all` also
sweeps unrecorded dirs under `.agentflow/worktrees/`).

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
content-keyed across reruns; `batch()` on openrouter cuts ~40–60% for
latency-tolerant stages (one job, ≤24h window — poll defaults are
`batchPollMs`/`batchTimeoutMs` per call or in `agentflow.json`). The
research says: fan out on parallelizable
sub-questions, always end in centralized synthesis/verification
(independent agents amplify errors ~17×), and don't fan out sequential work.

**Guards:** the script body shadows `Date`, `Math` and `crypto` by default;
`Date.now()`, `new Date()`, `Math.random()` and `crypto.randomUUID()` throw a
clear error because nondeterminism silently misaligns `--resume`/`--cache`.
Use `--allow-nondeterminism` to pass the real globals (advisory — a script can
still reach `globalThis.Date`). `--max-agents <n>` (default 1000) caps total
`agent()` calls per run. `--retries <n>` (default 0) re-runs transient failures
— cheap models flake on empty completions under burst; `agent(p, {retries: 2})`
for volume stages. Never retried: `permissionDenied` and `timedOut`. All three
settable in `agentflow.json` (`"allowNondeterminism": true`, `"maxAgents": 200`,
`"retries": 1`).

**Backgrounded runs:** `--detach` returns immediately with a run-id (the child
keeps running, output in `.agentflow/runs/<id>.log`). `agentflow status <id>`
prints settled/total + outcome (exit 2 while running), `agentflow tail <id>`
streams journal events until run-end, and `agentflow watch [id]` renders a
live phase-grouped terminal view — each `phase()` becomes a group header
with done/total counts, lanes list underneath with status + elapsed, and
settled lanes show a one-line result summary (first sentence of the agent's
reply — the "what it found"). Declared `meta.phases` with no calls yet render
as upcoming; the footer carries token totals and counts, and run-end shows
the big-ASCII spend card. Falls back to `tail` output when piped. Add
`--tmux` alongside `--detach` to auto-open the watch pane beside your shell
(needs an active tmux session; the pane stays open on run-end for the spend
card). Use detach for long fan-outs and check back — same model as Claude's
detached Workflow.

## Autonomous operation

A launched run needs no babysitting — the runner owns the pool, retries,
SIGINT drain, and journaling. Your job is the loop around it:

1. **Launch** with `--detach` for anything longer than a few calls; keep the
   run-id it prints.
2. **Monitor** with `watch <id>` (TTY) or `status <id>` (scripts) — token
   totals accumulate per call on devin so spend is visible mid-run.
3. **Heal**: interrupted or partially failed runs resume exactly —
   `agentflow run w.mjs --resume <id> --harness <same>` replays settled
   work and re-runs only the gaps; mid-poll batch interrupts re-poll the
   journaled batch id, never resubmit. A `null` slot in results is a failed
   call — count it, retry the script with `--resume` if it matters, don't
   panic-rerun everything.
4. **Report** the synthesis + `run <id>` (journal keeps prompt/result text;
   `status`/`watch` keep totals).

Don't re-orchestrate per-call in your own context — that's the thing
agentflow exists to remove. If a stage needs a decision from you, gate it
between two `run` invocations, not inside the workflow.

`agentflow stop <id>` SIGTERMs the journaled pid only when it verifies as the
run's own process (agentflow cmdline + start time matching the journal — a
reused or unverifiable pid is never signaled), then waits for run-end up to
`grace + 15s`; a still-draining run stays resumable and `status` keeps
reporting it. Exit codes for `status`/`tail`: `0` ended ok, `1` ended
error/determinism-lint, `130` interrupted, `2` running / orphaned /
no-journal (stdout says which). A run whose pid is dead but journal has no
run-end reports **orphaned** — resume it with `agentflow run <script>
--resume <id>`; a re-run `run-start` supersedes the old `run-end`, so a
resumed run shows as running again.

All run commands are **cwd-rooted**: journals and worktrees resolve against
the run's `--cwd` (default: your shell cwd). Run `status`/`stop`/`clean` from
the same directory you ran `run` from (or pass `--cwd`).

`agentflow clean` reclaims worktrees of runs that are not live — including
orphaned ones — and runs `git worktree prune`. **`clean` force-removes**:
uncommitted agent work in a worktree is destroyed. Harvest or commit
anything you want from a worktree before cleaning; `--all` additionally
sweeps dirs under `.agentflow/worktrees/` with no journal record or live
registration.

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
