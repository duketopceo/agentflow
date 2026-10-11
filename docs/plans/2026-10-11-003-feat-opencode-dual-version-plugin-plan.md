---
title: "feat: OpenCode plugin for v1 and v2 from one package"
type: feat
date: 2026-10-11
origin: "user request 2026-10-11 (v1 + v2 both); OpenCode v2 migrate-v1 guide; PR #19 research"
artifact_contract: ce-unified-plan/v1
---

# feat: OpenCode plugin for v1 and v2 from one package

## Product Contract

### Summary

Restore a working v1 tool surface alongside the v2 port, so one package serves every OpenCode user that can actually install a CLI — and so the install docs stop claiming a plugin exists only for a version nobody can run.

### Problem Frame

agentflow has shipped an OpenCode plugin that no user has successfully run.

The v1 plugin at `.opencode/plugins/agentflow.ts` read the child process through Bun's `` $`agentflow ${args}` `` helper and returned `.text()`. That captures **stdout only**. The runner writes every operator-relevant line to **stderr** — the phase markers, the per-lane `ok`/`fail` lines, the `[agentflow] run <run-id>` line, and the script's own `log()` output, which is how `workflows/deep-research.mjs` surfaces its synthesis. Verified directly against the current `main`:

```
=== STDOUT ONLY ===        (empty)
=== STDERR ONLY ===
[0.0s] [a] p -> ok (0.0s)
[0.0s] [a] SYNTHESIS_ON_LOG: echo[p]: say PONG
[agentflow] run 2026-10-11T08-48-18-e3406f18
```

So `agentflow_run` returned `""` on every successful run. A calling agent received no run-id, could not resume or stop the run, and on failure received only `ShellError: Failed with exit code 1` with the real reason discarded in stderr. No test covered the file: it is the only TypeScript file in a repo whose runtime is otherwise plain `.mjs`, and `grep -rl plugin tests/` returns nothing.

PR #19 (`feat/opencode-v2`, commit `73302f0`) ported the plugin to the OpenCode v2 contract and fixed the capture defect by moving to `execFile` and concatenating both streams. It also **deleted the v1 path outright**. That trade is correct on its own terms — v1 code does not run under v2 — but it leaves every currently-installable OpenCode with nothing, because v2 does not exist as a shipped CLI: `opencode-ai` tops out at `1.19.0`, and the installed binary is `1.18.33`.

The result is a branch whose CI is green without ever exercising the plugin, an install matrix that tells users to run a command that cannot succeed, and an untested v2 arm presented as working.

This plan keeps Devin's v2 arm and restores a v1 arm that captures stderr correctly, packaged so one install serves both.

### Requirements

- **R1.** One package exposes both implementations from a single default export — the dual-support shape the official v2 migration guide documents — so a single install serves v1 and v2 consumers.
- **R2.** The v1 arm registers `agentflow_run` and `agentflow_doctor`, returning non-empty text on success that contains the run-id and the script's own output.
- **R3.** Neither arm's success path can return an empty string, and neither may discard the failure reason when a run exits nonzero.
- **R4.** The v1 arm is exercisable on OpenCode `1.18.29+`; the v2 arm is preserved as Devin wrote it.
- **R5.** Install documentation is true for both versions, and states plainly that the v2 arm cannot be exercised until a v2 CLI ships.
- **R6.** The plugin's own contract is covered by tests that run in CI, so a future refactor cannot silently reintroduce an empty return.
- **R7.** `agentflow` remains on `PATH` as the only runtime requirement; the plugin adds no new install prerequisites.

### Success Criteria

- A v1 run through `agentflow_run` returns text containing the run-id; the same holds for the failure path, which returns the reason rather than a generic exit code.
- A test asserts a stub writing only to stderr still produces non-empty tool output — the specific regression that shipped.
- Neither install doc contains a command that cannot succeed on any released OpenCode.
- The v2 arm's unexercised status appears in the install notes, not only in a commit message.

### Scope Boundaries

**In scope:** the dual package shape, the v1 arm's tool registration and stream capture, dependency placement, tests for the plugin contract, and truthful install docs for both versions.

**Out of scope — non-goals for this plan:**

- Covering more of the CLI in the tool surface. `agentflow_run` and `agentflow_doctor` stay the only two tools; no detached-run lifecycle, no `start`/`status`/`stop` split, no result-retrieval verb. That is a separate design question with a separate answer.
- CI or lint work beyond what the new tests require.
- The OpenRouter usage/cost gap. Separately verified and separately real: the OpenRouter response carries `usage.cost` (USD) and `cost_details`, and `src/adapters/openrouter.mjs` discards them; `src/watch.mjs` reads `costUsd`, which no adapter sets. Unrelated to the plugin.
- Any change to the agentflow CLI's own output streams. The plugin must adapt to stderr, not the reverse.

**Deferred to follow-up work:**

- Deciding whether a result-retrieval verb should exist at all, given no CLI verb currently prints result text and the synthesis lives only in the JSONL journal.
- Replacing the exact dependency pin with a tested range across the whole manifest, once a live v2 install exists to test against.

### Key Decisions

- **Session-settled: cover both surfaces in one plan**, rather than picking v1 or v2. Chosen over a v2-only package, which would serve nobody installable today.
- **Session-settled: ship the plugin rather than skill-only.** The skill is the stronger surface and remains the primary one; this plan does not reopen that trade, and does not reduce skill coverage.
- **Session-settled: install fix and surface contract only.** Deliberately not a hardening pass.

## Planning Contract

### Key Technical Decisions

- **KTD1 — Dual export, not two packages.** Follow the migration guide's documented shape: one default export spreading `Plugin.define({id, setup})` for v2 alongside a v1 plugin function. Two packages would double the release surface and the manifests for no benefit; the guide states the APIs "remain separate" and that the shape does not translate hooks automatically, which is exactly the boundary wanted here — each arm keeps its native idiom and neither emulates the other.

- **KTD2 — The v1 arm captures stderr by construction, not by patch.** The defect was reading the wrong stream. Rather than append a stderr handler after the fact, the v1 arm uses the shell helper's combined-output path so no future edit can reintroduce a stdout-only read. The v2 arm's `execFile` + `${stdout}${stderr}` concatenation stays as Devin wrote it — it is already correct and matches the documented pattern.

- **KTD3 — Tool arguments are assembled by a shared pure function.** Both arms build argv identically today; duplicated assembly is how the two surfaces drifted in the first place. One exported helper produces the argv array from a spec object, so the two arms differ only in how they invoke it. This is what makes the shared contract testable without a live OpenCode.

- **KTD4 — Dependencies are scoped to where they are used.** The v1 arm needs `@opencode-ai/plugin`; the v2 arm needs `@opencode/plugin`. The v1 dependency goes back into the root manifest (the plugin is packaged from the repo root and `exports["./server"]` resolves there); the v2 SDK stays a peer dependency of the plugin subpackage rather than a root runtime dependency, so an installer who only needs the v2 path does not pull the v1 SDK. The dependency spec becomes a range rather than the exact pin Devin set at `1.18.34`, which is one patch ahead of the installed `1.18.33` — the skew that made the v1 pin unresolvable on this machine.

- **KTD5 — Tests target the contract, not the harness.** A stub binary writing only to stderr is the highest-value test here: it reproduces the shipped defect exactly without a live OpenCode, an API key, or a real run. Tool-registration shape is asserted by importing the plugin module and inspecting what it registers. This follows the existing `tests/fakebin/` pattern rather than inventing a second one.

- **KTD6 — Docs state the v2 arm's real status.** The install notes keep Devin's honest note that the v2 arm is written against the docs but not yet exercised, and add the v1 install path beside it. The README row stops advertising a single v2-only command.

### Assumptions

- The dual-export shape documented in the v2 migration guide is the intended and supported mechanism, and "V1 object entrypoints are supported in OpenCode 1.18.29 and newer" applies to a TypeScript default export reached through the existing `exports["./server"]` entry.
- `exports["./server"]` remains the correct entry key for v1 resolution, and `plugins/agentflow/` remains the correct `::path:` target for v2 installs.
- The v2 tool-registration shape in `plugins/agentflow/index.ts` is correct as written. The `await ctx.tool.transform(...)` form was flagged during planning and is **not** a defect — the official migration guide's own tool example uses that exact form; what must be synchronous is the inner `editor.add` callback, which Devin's code already satisfies.
- A future OpenCode v2 CLI will keep the v2 arm's `setup`/`ctx.tool.transform` contract intact. If it does not, the v2 arm is the half that needs revisiting first.

### High-Level Technical Design

Two arms, one entry, one shared argument builder. Drawn from the current branch (`feat/opencode-v2`, `73302f0`) and the v1 plugin that commit deleted.

```
                    package default export
                            |
        +-------------------+-------------------+
        |                                       |
   v1 arm (runs on 1.18.29+)            v2 arm (runs on 2.x)
   @opencode-ai/plugin                  @opencode/plugin
   Plugin.define(...).spread            Plugin.define({id, setup})
   + server()                           |
        |                                       |
        |        +------------------------+     |
        +------->| shared argv builder    |<----+
                 | (pure, exported)       |
                 +------------------------+
                           |
                  argv: string[]
                           |
              +------------+-------------+
              |                          |
       v1: $ shell helper        v2: execFile
       combined output           stdout + stderr
              |                          |
              +------------+-------------+
                           |
                  non-empty text out
                  (run-id + script log)
```

The stderr contract is the load-bearing part, and it is asymmetric between the runner and every consumer of it:

```
  agentflow runner                 plugin consumer
  -----------------                ----------------
  stdout:  (empty)                 v1 shell helper: COMBINED  -> has run-id
  stderr:  run-id                  v1 stdout-only (SHIPPED BUG): ""  -> lost
           phase/lane lines
           script log() output     v2 execFile: stdout+stderr -> has run-id
```

Any consumer reading only stdout loses the run-id and every `log()` line. The shared builder exists so both arms cannot drift on argv; the combined-output rule exists so neither can drift on streams.

---

### U1. Shared argv builder

**Goal:** One exported pure function turns a tool-argument object into the `agentflow` argv array, so both arms assemble invocations identically and the assembly is testable without a harness.

**Requirements:** KTD3; enables U2, U3, U4.

**Dependencies:** none.

**Files:** `plugins/agentflow/args.mjs` (new), `tests/opencode-plugin.test.mjs` (new).

**Approach:** A pure function taking `{script, harness, via, scriptArgs}` and returning `["run", script, ...flags, "--", scriptArgs]`, omitting absent optional flags. It must not shell out or touch the filesystem, so tests call it directly. Both arms import it rather than reimplementing the flag handling that is currently duplicated in each.

**Patterns to follow:** The flag vocabulary and ordering in `src/cli.mjs` `parseFlags` and the `run` command — `--harness`, `--via`, and the `--` separator are the existing contract, not new invention.

**Test scenarios:**
- Minimal spec (`script` only) produces exactly `["run", "w.mjs"]`, with no trailing separator.
- Each optional flag present produces its flag/value pair in the order the CLI documents.
- `scriptArgs` present appends `--` followed by the string as one argument.
- All optional fields absent and `scriptArgs` absent produce no `--` entry.
- An empty-string `scriptArgs` does not emit a trailing `--` (guards the malformed-invocation case).

**Verification:** Tests pass and the function is pure — importing it and calling it spawns no process and writes no journal.

### U2. v1 arm: tool registration and combined-output capture

**Goal:** Restore `agentflow_run` and `agentflow_doctor` for OpenCode `1.18.29+`, returning text that includes the run-id on success and the reason on failure.

**Requirements:** R1, R2, R3, R4, R7; KTD1, KTD2, KTD3, KTD4.

**Dependencies:** U1.

**Files:** `plugins/agentflow/index.ts` (modify — add the v1 arm alongside the existing v2 `setup`), `plugins/agentflow/args.mjs` (consume), `package.json` (restore the v1 SDK dependency as a range; keep `exports["./server"]` resolving to the dual entry).

**Approach:** The v1 arm is a plugin function receiving the v1 context (`$`, `directory`), returning a `tool` map built with the v1 `tool()` helper. Its shell invocation must capture combined output — the defect was reading stdout alone. Both tools route argv through U1's builder. On nonzero exit the returned text includes the captured stderr so the caller sees the real reason rather than a generic exit code. The two arms are combined in one default export per the migration guide, each keeping its native idiom: Zod-shaped args and a string return for v1, JSON Schema and `{content}` for v2.

**Execution note:** The capture path is the shipped defect, so write its test (U4) before finalizing this arm's return handling.

**Patterns to follow:** The deleted v1 plugin's tool descriptions and argument names, recovered from `git show 5102816:.opencode/plugins/agentflow.ts`, so tool-facing behavior stays stable across the version split.

**Test scenarios:**
- A stub `agentflow` writing only to stderr and exiting 0 yields tool output that is non-empty and contains the run-id line.
- A stub writing only to stderr and exiting nonzero yields tool output containing the stderr reason, not a bare exit code.
- `agentflow_doctor` against the stub returns the stub's captured output.
- The shared builder is used: a spec with `--harness` reaches the stub's recorded argv in the documented order (reuse the fakebin `FAKEBIN_ARGV_FILE` convention).

**Verification:** On OpenCode `1.18.29+` the plugin loads and both tools are registered; against a stderr-only stub, `agentflow_run` returns text containing the run-id.

### U3. Docs and packaging truth for both versions

**Goal:** Install documentation describes a v1 path that works today and a v2 path that is honestly labeled unexercised, and the README stops advertising a v2-only command.

**Requirements:** R5, R7; KTD6.

**Dependencies:** U1, U2.

**Files:** `.opencode/INSTALL.md` (modify), `README.md` (modify).

**Approach:** Keep Devin's existing note that the v2 arm is written against the docs and not yet exercised — that is accurate and must survive. Add the v1 install path beside it, note the `1.18.29+` floor for the v1 object entrypoint, and state the `agentflow`-on-`PATH` requirement once for both. The README install row gains the v1 command and keeps the v2 one labeled as requiring v2. The skill-only instructions stay — they remain the primary surface for anyone who does not want a plugin.

**Test expectation:** none — documentation only, no behavioral change to verify.

**Verification:** Every command in either doc corresponds to a released OpenCode version or is explicitly marked as requiring an unreleased one; no claim exists that a stranger cannot execute.

---

### Deferred to Follow-Up Work

- **A result-retrieval verb.** Verified absent: no CLI verb prints result text, so the synthesis lives only in `.agentflow/runs/<id>.jsonl`. Adding one would let a plugin tool return structured output instead of raw combined stderr. Distinct from this plan's tool surface.
- **Long-run lifecycle tools.** A `start`/`status`/`stop` split would let an agent manage a detached run without a blocking call. The v2 arm's 30-minute `execFile` timeout is a real constraint on long workflows, but splitting the tools is a surface decision this plan deliberately does not make.
- **v2 arm verification.** Blocked on a v2 CLI shipping. When one exists, load the plugin and exercise every registered tool, then verify cleanup by reloading — the migration guide's own five-step checklist.

## Risks and Dependencies

| Risk | Likelihood | Mitigation |
|---|---|---|
| The dual-export shape does not resolve as documented | Medium | The v1 arm is testable on this machine (`1.18.33` ≥ `1.18.29`). If resolution fails, the failure is visible immediately, not in a user's install. |
| v2 arm rots silently once a v2 CLI ships | High until then | R6 covers the shared contract; the v2 arm's status is stated in install docs, not only a commit message. |
| Exact dependency pins re-skew on the next opencode release | Medium | KTD4 moves to ranges for the v1 SDK. Full manifest range work is deferred, not silently skipped. |
| The two arms drift apart again | Medium | KTD3 shares argv assembly; U4's tests exercise the contract both arms implement. |

**Dependencies:** OpenCode `1.18.29+` for the v1 arm. `agentflow` on `PATH` for both. No API keys, network, or live v2 install.

## Documentation Plan

`.opencode/INSTALL.md` and the README install matrix are the only user-facing surfaces. Both get the v1 path; both keep the skill-only path; the v2 caveat stays visible in both.

## Sources and Research

- OpenCode v2 migration guide — dual v1/v2 export shape, `1.18.29+` floor for v1 object entrypoints, tool-migration before/after, the five-step verification checklist.
- OpenCode v2 plugin guide — `Plugin.define`, `ctx.tool.transform` (JSON Schema inputs, `{content}` returns, `context.signal`), discovery under `.opencode/plugins/`, `plugins` config key with v1 `plugin` still accepted.
- OpenCode v1 plugin docs — v1 `tool()` helper with Zod args, `$` shell helper, `ToolContext.ask`.
- Live verification against this machine: stdout/stderr split of `agentflow run` (the empty-return defect); `opencode --version` (`1.18.33`) and `opencode plugin --help` (v1 `<module>` form, no v2 subcommands); npm `opencode-ai` max `1.19.0`.
- PR #19 review — v2 arm correctness, zero plugin test coverage, install-doc drift.