---
title: "Agentflow v0.2 — fused cross-harness plugin, verified adapters, distribution"
status: ready_for_implementation
created: 2026-10-09
origin: "ce-plan invocation 2026-10-09; builds on PR #1 (feat/agentflow-core) and docs/research/*"
---

# Agentflow v0.2 — fused cross-harness plugin, verified adapters, distribution

## Problem Frame

v0.1 (PR #1, open) delivers the runner + 7 adapters + per-harness plugin
surfaces, but four adapters have never executed a real session, the Claude
parity gaps are unaddressed, the "one install pulls the whole stack" claim
is only half-wired (`optionalPlugins` doesn't auto-install), and there is no
real distribution story (no marketplace manifests, private repo blocks
anonymous plugin installs). v0.2 turns the working prototype into the fused
plugin the user described: dynamic workflows + the compound-engineering skill
suite installable in one step per harness, verified against live sessions at
the cheapest feasible cost posture.

## Scope

### In scope

- Merge/land PR #1 as precondition (user action — merge is not agent-granted).
- Live-smoke every adapter; record results in the adapter matrix.
- Cheap-first test posture: devin `swe-2-*` (free tier), opencode free models,
  ori/openrouter on `z-ai/glm-5.3-flash`-class slugs. Avoid claude-native and
  codex-native subscription burn — codex smoke runs `--via ori` instead.
- cube-sandbox (`localhost:3000`, key `omaseal: cubesandbox/api-key`) as the
  isolation target for the escalated-permission smoke cases.
- Fidelity gaps worth closing now: determinism lint, run-level agent cap,
  README/workflow documentation of what was deferred.
- CE fusion: devin `requiredPlugins` upgrade + a shipped `compound-loop`
  workflow expressing plan→work→review→compound as executable phases.
- opencode native plugin file (`.opencode/plugins/agentflow.ts`).
- Distribution: claude/codex marketplace manifests so
  `claude plugin marketplace add duketopceo/agentflow` and
  `codex plugin marketplace add duketopceo/agentflow` work; README install
  matrix; repo visibility decision carried to the user.

### Out of scope

- Hosted/daemon services, harness internals, the Linear-tool idea.
- True OR batch API adapter (`:batch` is a separate async API — research
  doc §3; backlog item).
- `--detach`/background mode and worktree-pool isolation (documented as
  backlog; agents can background the CLI themselves today).
- npm publishing (deferred until name/tag settled).

## Requirements

- **R1.** PR #1 merged to `main` before v0.2 branches — *precondition requiring user action*.
- **R2.** Every non-echo adapter executes ≥1 real headless call and the result is recorded in `docs/research/cross-harness-dynamic-workflows.md` §3.
- **R3.** `--strict` rejects workflow scripts containing `Date.now`, `Math.random`, `new Date(`, `crypto.randomUUID` at load time (mirrors Claude's inline-script determinism guard), with a clear error listing hits.
- **R4.** `--max-agents <n>` (default 1000, Claude parity) fails the run with exit 1 and a clear message when call count would exceed it.
- **R5.** `devin plugins install` on the plugin auto-installs compound-engineering (`requiredPlugins`); claude/codex/opencode installs document the CE pairing one line each.
- **R6.** `workflows/compound-loop.mjs` exists, runs on `--harness echo`, and expresses decompose→parallel work→review→compound phases.
- **R7.** `.opencode/plugins/agentflow.ts` loads in a local opencode project and registers an `agentflow` tool invocation path.
- **R8.** `.claude-plugin/marketplace.json` and the codex marketplace metadata make the repo a self-hosting marketplace for both harnesses.
- **R9.** Repo visibility question answered by the user; README install matrix matches the answer.
- **R10.** `node --test` suite stays green; `agentflow doctor` lists 7 adapters; escalated-permission smoke cases run inside cube-sandbox, never in the real checkout.

## Key Technical Decisions

- **KTD1 — Merge before build.** v0.2 work branches off `main` after PR #1 merges; parallel work on the same open PR accumulates unreviewable diff.
- **KTD2 — cheap-by-default smoke matrix.** devin (`swe-2-lite`), opencode
  (its free models), ori + openrouter on `glm-5.3-flash`. claude-native and
  codex-native are covered through `--via ori` where the goal is adapter
  correctness, not model quality. Expected total spend: < $0.10.
- **KTD3 — `requiredPlugins` not `optionalPlugins` for CE on devin.** The
  user's stated product is "one plugin for them all"; optional lists but
  doesn't install. CE is MIT and already the user's workflow substrate.
- **KTD4 — determinism lint is opt-in (`--strict`), not default.** Claude
  enforces it because its runtime relies on replay determinism; ours relies
  on call-order only for `--resume`/`--cache`. Strict mode is a guardrail
  authors opt into, matching our documented "determinism is your job" stance
  but giving teeth when wanted.
- **KTD5 — cube-sandbox only for the dangerous-path tests.** Trivial smokes
  ("reply OK") need no isolation; permission-escalation probes do. Keep the
  sandbox dependency out of the default test path — `omaseal` key required.
- **KTD6 — self-hosting marketplace manifests.** `.claude-plugin/marketplace.json`
  + codex equivalent make `plugin marketplace add duketopceo/agentflow`
  resolve without a third-party index. Mirrors how EveryInc ships CE.

## Implementation Units

### U0 — Precondition: merge PR #1 (USER GATE)

Human merges `duketopceo/agentflow#1` (all checks green, mergeable CLEAN;
Cursor's risk-high note acknowledged). v0.2 branches from `main` after.

### U1 — Adapter live-smoke matrix

Files: `scripts/smoke-harnesses.mjs` (new), `docs/research/cross-harness-dynamic-workflows.md` (results table update).

Per adapter, one scripted `agent("Reply with exactly: OK")`-class call via a
one-line workflow script; capture exit/text into the matrix:

- `devin` → `devin -p`, model `swe-2-lite` (free).
- `opencode` → a free built-in model if the installed version ships one
  (`opencode zen` free tiers); else route via `--via ori` on a cheap slug —
  record which path was used. Verify `--format json` event parsing live.
- `ori` → `ori code -p --model z-ai/glm-5.3-flash`.
- `openrouter` → `glm-5.3-flash` direct; needs `OPENROUTER_API_KEY` env
  (omaseal `openrouter/orchestral` per workspace eval-spend rule).
- `claude`, `codex` → via `--via ori` wrap on cheap OR slugs; note that
  this validates argv+parse paths, not native-billing paths.
- Escalated-permission probes (`permission:'escalated'` + a write command)
  run inside a cube-sandbox instance (`POST /api/v1/sandboxes` on
  `localhost:3000`, auth from `omaseal cubesandbox/api-key`), not the checkout.

Test scenarios: each adapter returns non-empty text; failures get classified
(permissionDenied/timeout/spawn) not crashed; matrix rows marked verified
with date + version.

### U2 — Determinism lint + run cap + via-ori model routing fix

Files: `src/runtime.mjs`, `src/cli.mjs`, `src/adapters/base.mjs`,
`src/adapters/{devin,claude,codex,opencode}.mjs`, `tests/*.test.mjs`.

- `--strict` (flag + `agentflow.json`): after `extractMeta`, scan body for
  `Date.now`, `Math.random`, `new Date(`, `crypto.randomUUID`; on hit, exit 1
  printing line numbers. Enforced before any agent call.
- `--max-agents n` (default 1000): `agent()` increments a counter; exceeding
  throws → run fails, journal records `run-end: cap-exceeded`.
- Wire `maxAgents` into `agentflow.json` config surface.
- **via-ori model fix (found in review):** under `via:'ori'` Ori consumes
  `--model` itself (any OR slug, translated per-harness) — but our adapters
  emit their native flag (`-m` codex/opencode, `--model` claude), which would
  pass through untouched and break on OR slugs. Each adapter gains a
  `modelFlag` field; `applyVia` strips the adapter's model pair and injects
  `--model <slug>` into the ori-consumed position (after the harness name).
  Adapters without `modelFlag` emit nothing under via-ori.

Test scenarios: script with `Date.now` fails under `--strict` listing the
line; same script passes without the flag; `--max-agents 2` on a 3-agent
script fails after exactly 2 calls with cap message; 1000-cap default doesn't
fire on small runs; `via:'ori'` + `model` produces `ori codex --model <slug>
exec ...` with no `-m` emitted; devin+via-ori still errors cleanly.

### U3 — CE fusion

Files: `.devin-plugin/plugin.json`, `workflows/compound-loop.mjs` (new),
`skills/agentflow/SKILL.md`, `README.md`.

- `.devin-plugin/plugin.json`: move CE from `optionalPlugins` to
  `requiredPlugins` (`{"source":"github","repo":"EveryInc/compound-engineering-plugin"}`).
- `workflows/compound-loop.mjs`: executable shape of the CE loop —
  `phase('plan')` architect agent → `phase('work')` parallel implementers →
  `phase('review')` reviewer agents → `phase('compound')` learning-capture
  writer. Runs on `echo`; documented as the template agents adapt.
- SKILL.md + README: state the pairing explicitly — devin auto-installs CE;
  claude/codex/opencode each get one documented install line.

Test scenarios: `agentflow run workflows/compound-loop.mjs --harness echo`
completes all four phases; `devin plugins install --local` on the repo shows
CE under required plugins.

### U4 — OpenCode native plugin

Files: `.opencode/plugins/agentflow.ts` (new), `.opencode/INSTALL.md`.

Real opencode plugin format (verified): `.ts`/`.js` modules under
`.opencode/plugins/` auto-load; a plugin function receives `{project,
directory, worktree, $}` and returns hooks/tools. Ship a plugin registering
an `agentflow_run` tool that shells `bin/agentflow run <script>` (bun `$`),
plus an `agentflow_list` tool for `agentflow list`. INSTALL.md updated: point
at the plugin file instead of manual instructions.

Test scenarios: file parses under `bun`/`tsc`-free opencode runtime (no
external deps — use `ctx.$`); `opencode` session in a project with the
plugin lists `agentflow_run` as a tool; invoking it runs a `--harness echo`
script end-to-end.

### U5 — Distribution

Files: `.claude-plugin/marketplace.json` (new), `.codex-plugin/` marketplace
metadata (new, per codex `plugin marketplace add` flow), `README.md`.

- Claude: marketplace.json listing the agentflow plugin →
  `claude plugin marketplace add duketopceo/agentflow` works.
- Codex: equivalent marketplace manifest → `codex plugin marketplace add
  duketopceo/agentflow` + `codex plugin add agentflow@agentflow`.
- Devin: already works via `devin plugins install duketopceo/agentflow`
  (requiredPlugins pulls CE).
- README install matrix: one row per harness, verified command each.
- Repo visibility decision (R9) — public flip recommended; on private repos
  `plugins install` requires auth'd GitHub access which strangers won't have.

Test scenarios: after merge + visibility decision, a scratch-directory
install from the GitHub URL succeeds for claude and codex; devin re-install
lists agentflow + CE.

### U6 — Final verification

`node --test tests/*.test.mjs` green; `agentflow doctor` 7/7; smoke matrix
fully populated; `agentflow run workflows/deep-research.mjs --harness
openrouter --cache` end-to-end on glm-5.3-flash (~$0.05); PR #2 opened.

## Risks

- **PR #1 merge is a human gate** — everything else sequences behind it.
- **codex/opencode flag drift** — smoke will surface it; adapters log the
  real stderr, `doctor` catches flag-level drift.
- **`requiredPlugins` resolution** — if devin can't resolve
  `EveryInc/compound-engineering-plugin` shorthand, fall back to explicit
  `{source, repo}` form or revert to `optionalPlugins` + README pairing.
- **opencode plugin API churn** — v1 vs v2 shapes differ; target the
  documented v2 `Plugin.define` shape and gate on the installed version.
- **Spend guardrails** — every smoke path is cheap-model by construction;
  the openrouter adapter requires an env key so accidental premium-model
  fan-out can't happen silently.

## Open Questions

- Codex marketplace manifest exact filename (`.codex-plugin/marketplace.json`
  vs other) — verify against codex docs during U5.
- Does `ori codex exec` pass through cleanly headless? (U1 answers this.)
- Public flip timing: before or after PR #2? (Before — installs need it.)
