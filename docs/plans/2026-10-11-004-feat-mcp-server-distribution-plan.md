---
title: "feat: `agentflow mcp` + full harness distribution"
type: feat
date: 2026-10-11
origin: "user request 2026-10-11 (top-10 harness map; MCP in, external submissions executed, npm decided-but-deferred); docs/publish-matrix.md research"
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# feat: `agentflow mcp` + full harness distribution

## Goal Capsule

**Objective:** a user on any major agent harness — including surfaces with no
plugin system — can install agentflow and get its real tools plus skill, with
published listings in the registries that have one.

**Means:** one zero-dep stdio MCP server wired through every manifest's
`mcpServers` field (KTD1, KTD2), plus executed external submissions (KTD4).

**Authority:** user-confirmed scope — MCP centerpiece, submissions fired not
just prepped, npm decided-but-deferred to a manual user action.

**Stop conditions:** never run `npm publish`; no paid model calls for
verification (stdio smoke + locally installed CLIs only).

## Product Contract

### Summary

Ship `agentflow mcp` — a stdio MCP server exposing the runner's tools — wire it
into every plugin manifest's `mcpServers`, execute the remaining registry
submissions, and stage the npm publish path.

### Problem Frame

agentflow only lights up real callable tools on OpenCode. Every other plugin
manifest ships SKILL.md alone — the harness *knows about* the runner but must
shell out blind. And an entire tier (Crush, Cline, Zed-ACP, Roo, Kilo, Kiro)
has no plugin surface at all — MCP is *their* extension point. One stdio
server collapses N tool implementations into one and reaches every
MCP-capable client, while plugins keep carrying what MCP cannot (skills,
agents/droids, hooks).

### Requirements

- **R1.** `agentflow mcp` answers MCP protocol over stdio — `initialize`,
  `tools/list`, `tools/call` — with no new runtime dependency.
- **R2.** Every manifest that can carry an `mcpServers`/`mcp.json` entry does,
  so a plugin install lights up tools without manual wiring.
- **R3.** The MCP tool surface is `run`, `doctor`, `status`, `tail`, `stop` —
  the verbs an agent needs mid-run. `watch` is excluded (alternate-screen TTY);
  `resume` is a `--resume` argument on `run`, not a separate tool.
- **R4.** External submissions executed: `cline/marketplace` entry,
  `block/agent-skills` skill folder, cursor.directory listing; awesome-list
  PRs optional.
- **R5.** The npm publish path is documented end-to-end with the name verified
  (`agentflow` unclaimed as of 2026-10-11 — 404 on `npm view agentflow` and
  `@duketopceo/agentflow`); the publish command itself stays the user's manual
  action. `package.json` `private` is unchanged until they fire it.
- **R6.** `docs/publish-matrix.md` and the README install table reflect the
  landed state of every surface.

### Key Decisions

- **KD1 — MCP in scope as the unified tool surface.** *(session-settled:
  user-directed — over per-harness tool ports: covers the no-plugin tier and
  collapses N implementations to one.)* Governs R1–R3.
- **KD2 — External submissions are executed, not merely staged.** *(session-
  settled: user-directed.)* Governs R4.
- **KD3 — npm is decided-but-deferred.** Publish path documented; the user
  fires `npm publish` themselves later. *(session-settled: user-directed.)*
  Governs R5.

### Scope Boundaries

- **In scope:** the MCP server, manifest wiring, registry submissions, npm
  runbook, verification on locally installed CLIs (`copilot`, `gemini`,
  `cursor`, `crush` are on this machine).
- **Deferred to follow-up work:** `npm publish` (user fires); OpenCode v2 live
  install (no v2 CLI published); Zed ACP agent-server (a separate, large lift);
  live install checks for `droid`/`cline`/`goose` (no local binaries —
  manifest-shape verification only).
- **Considered, not built:** `agentflow mcp` over HTTP/SSE transport (stdio is
  the universal local contract; remote transport reopens auth questions) —
  revisit if a hosted-server use case appears; a `watch` MCP tool (needs a TTY);
  `clean` (destructive verb — wrong shape for a model-callable tool).

## Planning Contract

### Key Technical Decisions

- **KTD1 — one server, wired everywhere.** Plugins gain an
  `mcpServers`/`mcp.json` entry spawning `agentflow mcp`; skills and
  agents/droids stay plugin content. *(session-settled: user-directed — over
  re-implementing tools per harness.)*
- **KTD2 — hand-rolled stdio JSON-RPC over `@modelcontextprotocol/sdk`.**
  agentflow's install paths often clone without `npm install` — a bare-clone
  `agentflow mcp` must still answer. The needed surface is small: newline-
  delimited JSON-RPC (`stdio` transport has no Content-Length framing; that is
  LSP), `initialize`/`notifications/initialized`/`ping`/`tools/list`/
  `tools/call`. SDK@1.32.1 is the documented fallback if protocol drift bites.
- **KTD3 — reuse the proven capture contract.** `plugins/agentflow/args.mjs`
  (`buildRunArgs`/`runAgentflow`: combined stdout+stderr, ENOENT/timeout
  naming) promotes to `src/` so the OpenCode plugin and the MCP server share
  one capture path — the stdout-only defect class must not re-enter through a
  second implementation (`docs/solutions/agent-orchestration/opencode-plugin-
  silent-defect-class.md`).
- **KTD4 — submissions via `gh` as the user's identity.** cline/marketplace:
  fork → `registry/skills/agentflow/entry.json` → PR. block/agent-skills:
  fork → `skills/agentflow/` folder → PR. cursor.directory is a web form —
  documented as the one manual step.
- **KTD5 — `agentflow mcp` is a `cli.mjs` subcommand**, not a separate binary:
  `bin/agentflow` dispatch gains `mcp`; `agentflow doctor` gains an `mcp`
  self-check row (spawn self, ping, report).

### High-Level Technical Design

```
harness plugin install
        │ reads manifest
        ▼
mcpServers entry ──spawn──▶ agentflow mcp (long-lived stdio child)
        │                          │ stdin: newline-JSON-RPC
        │                          ▼
        │                    dispatch: initialize / tools/list / tools/call
        │                          │
        │                          ▼  run/doctor/status/tail/stop
        │                    execFile("agentflow", argv) — combined
        │                    stdout+stderr capture (shared src/ helper)
        │                          │
        └──── tool result {content: out} ◀──
```

### Assumptions

- `mcpServers` field shapes differ per harness (`.mcp.json` file vs inline
  manifest field vs `mcp.json`); U2 verifies each against the harness's docs
  and, where a local CLI exists, a live install.
- The MCP `initialize` handshake's `protocolVersion` negotiation returns the
  server's supported version when the client's differs — implement from the
  spec text, pin in tests.

## Implementation Units

### U1. `agentflow mcp` — stdio MCP server

**Goal:** `agentflow mcp` serves `run`/`doctor`/`status`/`tail`/`stop` over
newline-JSON-RPC on stdio, zero-dep.

**Requirements:** R1, R3. **Dependencies:** none.
**Files:** `src/mcp.mjs` (new), `src/capture.mjs` (promote
`plugins/agentflow/args.mjs`; leave a re-export shim so the plugin import
path stays stable), `src/cli.mjs` (`mcp` subcommand + usage line),
`tests/mcp.test.mjs` (new), `tests/opencode-plugin.test.mjs` (import path
only).

**Approach:** line-buffered JSON-RPC dispatch; per-call `execFile` of the
agentflow binary through the shared capture helper (KTD3); tool results as
`{content:[{type:"text",text:out}]}`, failures throw a tool-level error
per the proven throw-on-failed-run contract. Method surface: `initialize`,
`notifications/initialized`, `ping`, `tools/list`, `tools/call`;
`-32700` parse error, `-32601` method not found, tool-level failures return
`isError:true` content rather than protocol errors.

**Test scenarios:**

- `initialize` handshake returns `protocolVersion`, `capabilities.tools`, and
  `serverInfo {name:"agentflow"}`
- `tools/list` returns exactly the five tools with `inputSchema` objects
- `tools/call run` against `tests/fakebin/agentflow` yields the run-id and
  `RESULT:` line in returned content (stderr-only capture — regression for
  the silent-defect class)
- failed run → `isError:true` result carrying the stderr reason, not a
  protocol-level error
- missing `agentflow` binary → content names "not found on PATH" (ENOENT
  naming, not a bare exit code)
- malformed JSON line → `-32700`; unknown method → `-32601`; unknown tool
  name → `isError:true` or `-32602`, per spec choice documented in code
- `doctor` tool returns non-empty probe output through the same path
- server emits no stdout bytes besides protocol frames (stderr diagnostic
  lines allowed)

**Verification:** `node --test tests/mcp.test.mjs` green; a raw
`printf … | bin/agentflow mcp` pipe answers initialize + tools/list.

---

### U2. `mcpServers` wiring across manifests

**Goal:** every plugin install that can light up the MCP server does.

**Requirements:** R2. **Dependencies:** U1.
**Files:** `.mcp.json` (root, canonical server block), `plugin.json`,
`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
`.cursor-plugin/plugin.json`, `.factory-plugin/plugin.json`,
`gemini-extension.json`, `.devin-plugin/plugin.json` (only if its format
supports mcp — check, else skip), `.opencode/INSTALL.md` note.

**Approach:** one canonical entry `{ "agentflow": { "command": "agentflow",
"args": ["mcp"] } }` adapted per harness's field shape; OpenCode stays native
(its plugin already ships real tools — no MCP wiring needed there).
Server `cwd` note where the format supports it.

**Test scenarios:**

- each manifest parses as JSON and the `agentflow` server entry resolves to
  `command: agentflow, args: ["mcp"]` (fixture-level assertions in
  `tests/mcp.test.mjs` or a manifest-shape test block)
- `gemini-extension.json` `mcpServers` block validates against the extension
  schema shape from its docs

**Verification:** manifests lint-clean; live install checks run under U3.

---

### U3. Local install verification

**Goal:** every locally installed harness CLI gets a real install+load check.

**Requirements:** R2 (execution-time proof), R6.
**Dependencies:** U1, U2.
**Files:** `docs/publish-matrix.md` (status column), `docs/smoke-matrix.md`
(MCP row).

**Approach:** `copilot plugin install duketopceo/agentflow` or local-path
equivalent; `gemini extensions install <repo>`; `crush` MCP config add →
`crush mcp list`; `cursor` local plugin dir load. Each check records
pass/fail verbatim into publish-matrix. `droid`/`cline`/`goose` absent →
"no local binary" rows, not silent skips.

**Execution note:** mostly packaging/config — prefer install/runtime smoke
over unit coverage.

**Test expectation:** none for code; the checks ARE the verification.

**Verification:** each install either loads tools (assert via the harness's
own listing) or the row records the exact failure.

---

### U4. External registry submissions

**Goal:** listings live (or PRs open) on cline/marketplace and
block/agent-skills; cursor.directory submission documented and ready.

**Requirements:** R4 (KD2, KTD4). **Dependencies:** none on code — can land
in parallel with U1–U3, but description text benefits from U1 existing.
**Files:** external PRs; `docs/publish-matrix.md` status updates;
`docs/submissions.md` (new — tracks each submission's URL/state).

**Approach:**

1. `cline/marketplace`: `gh repo fork`, add
   `registry/skills/agentflow/entry.json` per its schema (install args =
   repo clone + `npm link`/`bin/agentflow` PATH step), `npm run validate`
   in the fork, open PR.
2. `block/agent-skills`: fork, add `skills/agentflow/` folder (our SKILL.md
   verbatim + any supporting files it requires per their validator), open PR.
3. cursor.directory: web-form submission — write the exact listing text +
   steps into `docs/submissions.md`; the user clicks submit.
4. Optional: awesome-opencode / awesome-claude-plugin list PRs.

**Test expectation:** none — external artifacts; PR URLs recorded in
`docs/submissions.md`.

**Verification:** PRs open (or merged) and linked; the submission doc lists
each target, action taken, and state.

---

### U5. npm publish runbook (decided, deferred)

**Goal:** publishing is a documented one-step decision the user can fire any
time — name verified, package shape audited, exact commands written.

**Requirements:** R5 (KD3). **Dependencies:** none.
**Files:** `docs/npm-publish.md` (new), `README.md` (npm row stays
"not yet published — git install is the path" until fired).

**Approach:** document the verified facts (both `agentflow` and
`@duketopceo/agentflow` 404 on 2026-10-11 — either name is claimable), the
publish checklist (flip `private`, pick name, `npm publish --access public`,
version discipline vs `plugin.json` version fields), and the files-whitelist
contents so the tarball ships only what plugins need.

**Test expectation:** none — documentation unit.

**Verification:** runbook reviewed; a dry `npm pack --dry-run` file listing
matches the intended payload.

---

### U6. Docs refresh

**Goal:** publish-matrix, README, INSTALL reflect landed reality.

**Requirements:** R6. **Dependencies:** U1–U5.
**Files:** `docs/publish-matrix.md`, `README.md`, `.opencode/INSTALL.md`,
`docs/smoke-matrix.md`.

**Approach:** status column per harness updated from U3's results; README
gains an MCP row ("any MCP client: `agentflow mcp` via `.mcp.json`").

**Test expectation:** none — docs.

**Verification:** every install row in README/publish-matrix is either
verified, explicitly unverified, or a documented manual step.

## Verification Contract

- `node --test` — full suite green including `tests/mcp.test.mjs`.
- `printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' | bin/agentflow mcp` — returns a capabilities frame.
- Live install checks per locally installed CLI (U3) recorded in
  `docs/publish-matrix.md`.
- External submission PRs linked from `docs/submissions.md`.

## Definition of Done

- `agentflow mcp` answers initialize/tools-list/tools-call over real stdio
  with zero new runtime deps.
- Every manifest that can carry `mcpServers` does; OpenCode keeps its native
  tools (no MCP needed there).
- External submissions fired (PRs open) or the one manual web-form step is
  staged verbatim.
- npm runbook written; `private` flag untouched.
- Suite green; no abandoned-attempt code left in the diff.
