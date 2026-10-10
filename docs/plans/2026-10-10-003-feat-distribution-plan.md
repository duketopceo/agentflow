---
title: "M7 — distribution: visibility flip, verified installs, npm decision"
status: ready_for_implementation
created: 2026-10-10
origin: "M5–M8 roadmap set (2026-10-10); v0.2 R9 user gate still open"
---

# M7 — distribution: visibility flip, verified installs, npm decision

## Problem

The README advertises `plugin marketplace add duketopceo/agentflow` for
claude/codex and `plugins install` for devin/opencode — all of which fail for
anyone without GitHub auth while the repo is `PRIVATE`. The v0.2 R9
visibility gate never got an answer, npm publish was deferred without a
decision, and `package.json` still says `"private": true`. Everything
agent-doable lands in this milestone; the two human gates are explicit stops,
not blockers.

## Scope

### In scope

- Publish-readiness prep: package manifest files/whitelist, name decision,
  README truth pass against actual visibility.
- GATE: repo visibility flip to public + workspace security standard applied
  (PR+1-review branch protection, fork-PR approval).
- Post-flip verification: each advertised install path run once from a
  scratch dir, manifests fixed until they work.
- GATE: npm publish — scoped name, or documented "not published" — decided
  and closed either way.

### Out of scope

- Third-party/official marketplace catalogs (Claude, Codex) — self-hosted
  manifests only.
- Release automation (release-please/changesets), docs site, installers.
- Any paid promotion, announcement, or growth work.

## Requirements

- **R1.** README install matrix is truthful about visibility at every step —
  no claim survives that a stranger can't execute.
- **R2.** The public flip is immediately followed by the workspace repo
  standard: default-branch protection (PR + 1 review, no force-push/delete)
  and `first_time_contributors` fork-PR approval — free GitHub tier cannot
  set API branch protection on private repos, so the flip is what unlocks
  the standard.
- **R3.** Each advertised install path is verified once from a clean scratch
  dir post-flip; failures fix the manifest, not the docs.
- **R4.** npm gets a definitive answer: published scoped name or an explicit
  "not published" note — never silently `"private": true` forever.

## Key Technical Decisions

- **KTD1 — gates are pauses, not blockers.** Prep and doc-truth work lands
  before either gate; an `lfg` run stops cleanly at the flip/publish actions
  with exact commands + rollback noted.
- **KTD2 — scoped name if published.** `agentflow` is likely squatted on npm;
  check `npm view agentflow` at implementation and default
  `@duketopceo/agentflow` with `publishConfig.access: public`. No-publish is
  a documented outcome, not a failure.
- **KTD3 — verify from a stranger's position.** Scratch tmp dir, no local
  clone assumptions — the exact resolution path a foreign harness runs.
- **KTD4 — flip unlocks protection, so they travel together.** Private free-
  tier repos can't receive API branch protection (noted in
  `docs/solutions/agent-orchestration/pooled-subprocess-agents-invariants.md`);
  the audit/fix step is part of the same unit as the flip, not a follow-up.

## Implementation Units

### U1. Publish prep + README truth pass

**Goal:** package manifest is publish-ready; docs never overclaim.

**Requirements:** R1, R4

**Dependencies:** none

**Files:** `package.json`, `README.md`

**Approach:** `files` whitelist in `package.json` (`bin`, `src`, `skills`,
`workflows`, `examples`, manifests, `README.md`, `LICENSE` — excludes
`tests/`, `docs/`, `.agentflow`); `npm view agentflow` result decides the
name (`@duketopceo/agentflow` if taken); `publishConfig` set if publishing
stays on the table; `private` flag resolved by the name decision, not left
drifting. README gains a visibility callout above the install matrix until
U2 lands.

**Test scenarios:**

- `npm pack --dry-run` contents: no `tests/`, `docs/`, `.agentflow`, plans.
- `npm view agentflow` output recorded in the PR description → name decision
  traceable.

**Verification:** manifest is internally consistent — either publishable
scoped or explicitly private with a note.

### U2. GATE — visibility flip + security standard (human)

**Goal:** repo public, protection applied in the same step.

**Requirements:** R2

**Dependencies:** U1

**Human action:** `gh repo edit duketopceo/agentflow --visibility public`,
then the workspace audit (`gh-repo-audit` + `--fix` — the standard: PR + 1
review on main, no force-push/delete, `first_time_contributors` fork-PR
approval). Rollback: flip back to private (protection persists silently).

**Test scenarios:**

- `gh repo view --json visibility` → `PUBLIC`.
- `gh api repos/duketopceo/agentflow/branches/main/protection` → required PR
  reviews present; audit log line appended at
  `~/.local/state/gh-repo-audit.log`.

**Verification:** a fresh anonymous `gh repo view duketopceo/agentflow` works;
direct push to main is rejected.

### U3. Install verification matrix

**Goal:** every advertised install path proven once from a clean position.

**Requirements:** R1, R3

**Dependencies:** U2

**Files:** `README.md` (verification footnote/date), manifests under
`.devin-plugin/`, `.claude-plugin/`, `.codex-plugin/`, `.opencode/` if fixes
are needed

**Approach:** scratch tmp dir per harness, run exactly what the README says:
`claude plugin marketplace add duketopceo/agentflow`; `codex plugin
marketplace add duketopceo/agentflow`; `devin plugins install -y
duketopceo/agentflow` (assert compound-engineering also lands via
`requiredPlugins`); `opencode plugin add github:duketopceo/agentflow` per
`.opencode/INSTALL.md`. Any failure → fix the manifest → re-verify.

**Test scenarios:**

- Each row verified end-to-end or its manifest corrected + re-run; results
  footnoted in README with the verification date.

**Verification:** a stranger could follow the matrix; no row is asserted
untested.

### U4. GATE — npm publish decision + close-out (human)

**Goal:** the npm question is answered, not deferred again.

**Requirements:** R4

**Dependencies:** U1 (U3 not required — npm is orthogonal to plugin installs)

**Human action:** publish → `npm publish --access public` after `npm pack`
review + `git tag v<pkg.version>` matching `package.json`; no-publish → the
decision is written down.

**Test scenarios:**

- Publish path: `npm view <name>` resolves post-publish; README gains the
  `npm i -g` install row.
- No-publish path: README carries "not published to npm — install via plugin
  manifests"; `private:true` restored.

**Verification:** no ambiguous middle state — name resolves or the note exists.

## Deferred to Follow-Up Work

- Official marketplace catalog submissions for claude/codex.
- Release automation (release-please/changesets) once versioning cadence
  exists.
- Announcement/promotion — deliberately out.
