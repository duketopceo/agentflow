---
title: "Program roadmap: from v0.2 runner to a trustworthy cross-harness workflow runtime"
status: active
created: 2026-10-10
origin: "docs/research/2026-10-10-landscape.md; open PRs #7 (M5) and #8 (M6); plans 001-004 (M5-M8)"
type: program
---

# Program roadmap

## Problem frame

agentflow runs one workflow script across `devin`, `claude`, `codex`,
`opencode`, `ori` and a direct `openrouter` adapter. v0.2 on `main` has the
runner, journal, `--resume`, `--cache`, `--via ori`, `--detach`, retries and a
live smoke matrix. Two PRs are in flight (M5 tests + CI, M6 ops parity). The
landscape research shows three gaps against what users of Claude's native
workflows, Temporal and LangGraph expect: resume that checks what it replays,
enforced determinism, and scripts that are genuinely portable to and from
Claude's runtime. This plan orders the remaining work and says where to build
less.

Scope: a program-level roadmap. Individual units become their own plans when
picked up. Application code is out of scope for this PR.

## Status key

`done` merged on `main` · `in-review` open PR · `planned` not started ·
`candidate` worth doing only if the stated trigger is met.

## Now

### U1. Land M5: deterministic suite and CI (PR #7)
- **Status:** in-review. Evidence: PR #7 body reports 65 tests, fakebin e2e
  stubs for all five CLIs, `spec.fetchImpl` seam, CI on Node 20/22/24/26.
  On `main` today `npm test` exits 1 under Node 26.7 because `node --test tests/`
  is treated as a path (verified in this pass: `npm test` exit 1, bare
  `node --test` exit 0, 47/47 pass).
- **Dependencies:** none.
- **Verification:** CI green on the four Node versions; `npm test` exit 0 locally.
- **Difficulty:** easy. It is reviewed and review fixes are applied.
- **Feasibility:** blockers are review latency and the unchecked "CI green" box.
  `engines` bump to `>=20.3` is a (small) breaking change for Node 20.0-20.2.
- **Simpler alternative:** if fakebin stubs are judged too heavy, keep only the
  `package.json` fix (`node --test`) and the CI file, which is most of the value.
  Candidate to delete: nothing on `main`; the stubs in `tests/fakebin/` are the
  new surface.

### U2. Land M6: ops parity (PR #8)
- **Status:** in-review. Evidence: PR #8 body (stop, clean, orphan detection,
  `worktree: 'auto'`, `scripts/smoke-harnesses.mjs`, 73 tests).
- **Dependencies:** U1 (both edit `.github/workflows/test.yml` and
  `package.json`). Per the stacked-PR rule, retarget to `main` and rebase; do not stack.
- **Verification:** `node --test` green; run `node scripts/smoke-harnesses.mjs --only echo`.
- **Difficulty:** medium. Large diff touching `cli.mjs`, `journal.mjs`, `runtime.mjs`;
  already 11-persona reviewed.
- **Feasibility:** `rm -rf`-class code (`clean`) and pid signalling need the
  containment checks the PR claims; live smoke rows need credentials and spend.
- **Simpler alternative:** `agentflow clean` could be `git worktree prune` plus a
  documented `rm -r .agentflow/worktrees`; the pid-identity check in `stop` is the
  part worth keeping. `scripts/smoke-harnesses.mjs` duplicates the hand-run table in
  `docs/smoke-matrix.md`; keep the script, generate the table from it, delete the prose.

### U3. Replay guard: refuse stale results on `--resume`
- **Status:** planned. Evidence: `src/runtime.mjs` replays `prior.settled.get(i)` by
  call index with no check that the prompt matches; Claude's runtime reruns from the
  first differing prompt (https://code.claude.com/docs/en/workflows#resume-after-a-pause).
- **Dependencies:** U2 (journal epochs live there).
- **Verification:** new runtime test: edit a prompt between runs and assert the
  changed call and everything after it re-executes; journal records a prompt hash.
- **Difficulty:** medium. Small code change, but it changes journal format and needs
  a compatibility path for existing journals.
- **Feasibility:** none external. Decision needed: rerun everything after the first
  mismatch (Claude's rule, wasteful) or only mismatched calls (cheaper, but order
  assumptions break). Start with Claude's rule for parity.
- **Simpler alternative:** make `--cache` (content-keyed, already built) the default
  resume mechanism and drop positional replay entirely. That deletes
  the index-matching path in `runtime.mjs` and removes a whole class of stale-replay bugs, at
  the cost of cache files holding results between runs.

### U4. Script contract parity with Claude's native workflows
- **Status:** planned. Evidence: Claude scripts end with `return <value>` and read
  `args` as structured data; agentflow's `fn(...)` result is discarded in `runScript`
  and `args` is always a string array. Claude also supports per-agent `stallMs`.
  `workflows/deep-research.mjs` calls `process.exit(2)` on bad input, which Claude's
  sandbox would not allow.
- **Dependencies:** none.
- **Verification:** a Claude-style script (copied from the docs example) runs
  unchanged under `--harness echo`; its `return` value is printed and journaled;
  `--args-json` yields structured `args`.
- **Difficulty:** medium. Changes touch `runtime.mjs` and `cli.mjs`; the risky
  part is deciding the output surface for the return value.
- **Feasibility:** Claude's contract is documented but not versioned; it may move
  (it changed between 2026-10-08 and today: `/workflow-authoring`, `stallMs`).
  Pin to a documented subset rather than chase it.
- **Simpler alternative:** document the three gaps in SKILL.md and ship one
  conformance script instead of changing the runtime. Cheaper, but the main
  differentiator (portability) stays aspirational.

### U5. Close distribution: npm decision and truthful install docs
- **Status:** planned (M7 plan 003). Evidence: the repo is already public
  (`gh api`: `visibility: public`), so the visibility gate in plan 003 is stale;
  `package.json` still has `"private": true`. README install matrix was not
  verified from a clean directory in this pass.
- **Dependencies:** U1.
- **Verification:** each install row in README run once from a scratch dir; `npm pack --dry-run`
  file list reviewed.
- **Difficulty:** easy for docs, medium if publishing (human gate).
- **Feasibility:** npm name `agentflow` may be squatted; scoped name needs an org;
  the Claude and Codex marketplace schemas are unverified against real installs.
- **Simpler alternative:** do not publish to npm. Keep `git clone` + `bin/agentflow`
  and the plugin manifests, and record "not published" explicitly (plan 003's KTD4
  allows this). Delete `.agents/plugins/marketplace.json` if the Codex install path
  cannot be verified.

## Next

### U6. Determinism enforced at runtime, not by regex
- **Status:** planned. Evidence: `lintDeterminism` in `runtime.mjs` is a regex over
  source text and only runs with `--strict`; Claude and Temporal enforce at runtime.
- **Dependencies:** U4 (shares the script sandbox).
- **Verification:** a script calling `Date.now()` fails with a clear error under
  default settings; `--allow-nondeterminism` opts out.
- **Difficulty:** easy. Shadow `Date`, `Math` and `crypto` as `AsyncFunction` parameters.
- **Feasibility:** the script runs in the host process via `AsyncFunction` (no real sandbox);
  shadowing is advisory, not a security boundary. State that plainly.
- **Simpler alternative:** delete `lintDeterminism` and the `--strict` flag once
  runtime enforcement ships (about 15 lines in `src/runtime.mjs`, plus its tests
  and the `strict` key in `agentflow.example.json`).

### U7. Validated structured output
- **Status:** planned. Evidence: only codex uses a native schema; every other adapter
  does `withSchemaPrompt` + `extractJson`, and a parse miss becomes `null`
  (`base.mjs`). Claude validates and retries up to five times.
- **Dependencies:** U1 (needs fakebin tests).
- **Verification:** fakebin stub returns invalid JSON once then valid; call resolves
  with the valid result; a permanently invalid reply yields `null` with an error naming the schema failure.
- **Difficulty:** medium.
- **Feasibility:** a JSON-Schema validator is a new dependency (the repo has one
  runtime dep today); a 60-line subset validator avoids it but is a maintenance
  liability.
- **Simpler alternative:** one repair retry that re-prompts with the parse error,
  checking only "is an object/array with the required keys". No validator library.

### U8. Per-agent usage in the journal
- **Status:** planned. Evidence: journal `agent` records carry `elapsed` and `model` only;
  claude's JSON envelope and OpenRouter responses include usage, others do not.
- **Dependencies:** U1.
- **Verification:** journal records `usage` when the adapter supplies it; `status` prints totals and
  says "n/a" for adapters that do not report.
- **Difficulty:** medium. Four output formats, two of which (`devin`, `codex` text)
  may not expose tokens at all.
- **Feasibility:** blocked per adapter by what the CLI prints. Do not estimate.
- **Simpler alternative:** record usage only for `openrouter` and `claude` where it is
  already in the payload; skip the rest and say so.

### U9. Workflow library from the documented patterns
- **Status:** planned. Evidence: `workflows/` has `deep-research` and `compound-loop`;
  Claude's docs list audit-per-file, fix-until-check-passes, parallel migration in
  worktrees, PR review with merged summary, and find-until-no-new-results.
- **Dependencies:** U2 (`worktree: 'auto'`), U4.
- **Verification:** each script runs under `--harness echo` in CI; one is run live per release.
- **Difficulty:** easy per script.
- **Feasibility:** live verification costs money; echo only proves the control flow.
- **Simpler alternative:** ship two (audit and migrate), not five. More scripts
  means more prose to keep truthful.

### U10. One manifest source for four plugin surfaces
- **Status:** planned. Evidence: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
  `.devin-plugin/plugin.json`, `plugin.json`, `.claude-plugin/marketplace.json` and
  `.agents/plugins/marketplace.json` repeat name, version and description by hand.
- **Dependencies:** U5.
- **Verification:** `scripts/sync-manifests.mjs --check` fails CI on drift.
- **Difficulty:** easy.
- **Feasibility:** each harness's schema differs and may change; generate only the shared fields.
- **Simpler alternative:** delete manifests for harnesses where the install path was not
  verified in U5 rather than generating them.

### U11. Refresh the research docs
- **Status:** planned. Evidence: `docs/research/cross-harness-dynamic-workflows.md` §4/§5
  lists shipped features as open (see landscape §5).
- **Dependencies:** none. **Verification:** a grep for `open follow-up` finds nothing that is shipped.
- **Difficulty:** easy. **Feasibility:** none.
- **Simpler alternative:** mark the two older research docs as dated snapshots in their
  headers instead of editing them.

## Later

### U12. Terminal progress view
- **Status:** candidate. Trigger: users run more than ~20 agents and `tail` is not enough.
- **Dependencies:** U2 (stop/clean), U8 (usage).
- **Verification:** snapshot test of the rendered frame from a fixture journal.
- **Difficulty:** medium.
- **Feasibility:** no dependency needed for ANSI output; pause/restart-an-agent controls
  need runner support that does not exist (the runner cannot restart one agent today).
- **Simpler alternative:** `status --watch` with a redrawn table; no interactive controls.

### U13. OpenRouter batch adapter (M8, plan 004)
- **Status:** candidate; recommend deferring. Evidence: measured end-to-end cost of a
  12-call deep-research was about $0.003 (`docs/smoke-matrix.md`); batch saves roughly
  40-60% of that.
- **Dependencies:** U1 (the `fetchImpl` seam).
- **Verification:** per plan 004, plus a live run on a `:batch` slug.
- **Difficulty:** hard. It adds a new job lifecycle (submit, poll, resume by batch id)
  to a runtime built on one-process-per-call.
- **Feasibility:** OpenRouter's Batch API shape was verified once on 2026-10-10 and is
  young; one model per batch; spend must go through the `orch` wrapper key.
- **Simpler alternative:** do not build it. Cheap models already make the dominant workload cost cents.
  Revisit only if a real workflow costs more than a few dollars per run.

### U14. Programmatic API and Agent SDK embedding
- **Status:** candidate. `runScript` is already exported from `src/runtime.mjs`; the package is `private` and has no `exports`.
- **Dependencies:** U5.
- **Verification:** `import { runScript } from 'agentflow'` in a scratch project.
- **Difficulty:** easy to expose, medium to stabilise as an API.
- **Feasibility:** commits to a semver surface.
- **Simpler alternative:** keep the CLI as the only public interface.

### U15. Workflow auto-optimisation (AFlow-style)
- **Status:** candidate, research only. AFlow (arXiv:2410.10762) searches workflow code by
  MCTS with execution feedback.
- **Dependencies:** U7, U8 (needs scoring and cost signals).
- **Verification:** a benchmark task where an optimised script beats the hand-written one at equal cost.
- **Difficulty:** hard. **Feasibility:** needs an eval budget (`orch` key, $50/month cap) and a metric.
- **Simpler alternative:** skip; ship U9 patterns and let users iterate with `--cache`.

## Biggest simplification

Do not build M8 (U13), delete `lintDeterminism` once U6 lands, and choose one of
the two resume mechanisms (U3 alternative): positional journal replay or content-keyed
`--cache`. Two memo systems plus four hand-maintained manifests is more surface than
a 1,100-line runner needs.

## Out of scope

Hosted execution, multi-machine runs, a web dashboard, sandboxing of the script
body, and any paid marketing.
