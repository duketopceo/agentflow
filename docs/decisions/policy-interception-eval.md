# Decision: policy interception (`govern()`) in the worker path

**Status:** decided — **adopt the pattern, not the toolkit** (thin governor, no SDK dependency)
**Date:** 2026-11-01
**Plan:** `docs/plans/2026-10-19-004-eval-policy-interception-govern-plan.md`
**Sibling:** `docs/plans/2026-10-19-003-eval-worker-sandboxing-plan.md`
**Evidence:** `evals/policy-interception/` (scratch harness, 13/13 scenarios green)

## Verdict

Adopt the **pattern** — a thin `govern()`-style wrapper plus hash-chained audit —
without taking `@microsoft/agent-governance-sdk` as a runtime dependency.

## What was evaluated

Microsoft's `agent-governance-toolkit` (6.4k★, MIT). Its headline `govern(fn,
policy)` API is Python-first; the TypeScript SDK
(`@microsoft/agent-governance-sdk@5.0.0`, "public preview — APIs may change")
installs cleanly on Node ≥20 (verified on v26.7.0, aarch64) and provides
`PolicyEngine`, `AuditLogger`, `AgentMeshClient`, plus identity/trust/rings.

The scratch harness wraps a representative worker tool surface (`shell.exec`,
`fs.write`, `net.fetch`) with a YAML policy: deny destructive shell, deny egress
off an allowlist, `require_approval` on writes outside the worktree,
fail-closed default. All 13 scenarios pass: allow executes, deny raises
`GovernanceDenied` with no partial execution, `require_approval` parks the call
and resumes on grant (or clears on reject), the audit trail records decision +
inputs per call, and tampering with an exported log is caught by re-verifying
the SHA-256 hash chain.

## Why the SDK isn't the dependency

1. **agentflow's tool surface isn't where the SDK aims.** `govern()` wraps
   in-process function calls. agentflow's workers are *external CLI processes*
   spawned through `spawnProcess` (`src/adapters/base.mjs:8`) /
   `spawnAgent` (`src/adapters/base.mjs:238`). The tool calls that matter —
   what `claude`, `devin`, `codex` do inside their own runtimes — are
   invisible to a wrapper in our process no matter which library provides it.
   The honest interception point in agentflow is the **spawn boundary**:
   argv construction, binary allowlist, cwd, env. Governing that needs ~100
   lines, not a 60-export SDK.
2. **The condition language can't express our rules.** `evaluatePolicy`
   supports `==`, `!=`, numeric comparison, `in`/`not in`, boolean flags,
   `and`/`or` — **no substring, glob, or regex on values**. "Deny `rm -rf`"
   and "non-allowlisted host" can't live in the YAML; the harness precomputes
   `destructive`, `host_allowed`, `outside_worktree` in JS and passes them as
   booleans. The real policy logic already lives in our wrapper — the SDK
   contributes dispatch and a verdict enum.
3. **Audit is in-memory only.** `AuditLogger` is a well-built hash chain
   (each entry's hash covers content + previous hash; `getEntries` returns
   defensive copies; eviction keeps a seam hash) but has **no import/load** —
   `exportJSON` only. Restart persistence and post-hoc verification must be
   bolted on anyway (the harness does it in ~30 lines, `verifyAuditFile`).
   Inputs ride in `skillAuditMetadata` — undocumented, discovered from source.
4. **Maturity.** Public preview, APIs may change; the legacy `evaluate()` path
   returns `require_approval` at runtime but types it as `'review'`. For a
   security-critical seam, that's the wrong direction of stability leverage.

## What the pattern buys us

A `govern()`-equivalent around `spawnProcess`/`spawnAgent` gives agentflow:
per-invocation policy (binary allowlist, forbidden-flag rules, worktree
confinement checks), an approval gate seam for human-in-the-loop runs, and a
tamper-evident decision log next to the existing journal (`src/journal.mjs`).
If a follow-on wants the SDK's real differentiators — Ed25519 agent identity,
trust scoring, OPA/Cedar backends, the Claude Code plugin — it's an additive
upgrade behind the same seam, not a prerequisite.

## Layering contract (reconciling with the sandboxing plan)

> **govern = intent policy, sandbox = capability boundary.**

govern() decides whether an action *should* run (per call, with approvals and
an audit trail). Sandboxing decides what the process *can* do (fs/net
restrictions enforced below the JS layer). Neither substitutes for the other:

- **Blind spot of govern() (verified in harness, scenario 9):** an unwrapped
  code path executes unaudited — a worker that spawns around the wrapper
  defeats it entirely. Intent policy must therefore sit at the single choke
  point (`spawnProcess`) AND be paired with process-level isolation.
- **Blind spot of sandboxing:** it can't express "ask a human first" or
  record intent — a capability boundary has no approval concept.

## Follow-on (separate work)

- Wrap `spawnProcess` (`src/adapters/base.mjs`) with a local governor:
  action = `worker.spawn`, context = `{bin, argv, cwd, adapter}`; deny rules
  for binary allowlist violations and `--dangerously-*`-class flags;
  audit entries appended to the journal as hash-chained records.
- Approval UX: none exists in-process today; a `require_approval` verdict can
  surface as a queued prompt in `watch`/`cli` before resume.
- Re-evaluate the SDK if/when MCP-level governance (ContextForge) or
  per-agent identity lands — that's where its identity/trust modules earn
  their weight.

## Honest notes

- Python SDK is the mature surface (`govern(fn)` decorator, richer condition
  handling); running a Python sidecar for a Node codebase to wrap spawn calls
  is not justified — the TS parity gap is a point against the lib, not the
  pattern.
- Everything audited is advisory until the wrap lands at the single spawn
  choke point. Any new direct `spawn`/`execFile` call site is a policy bypass.
- Test scenario caveat: the harness's `destructive` regex is illustrative,
  not a production classifier; shell-command classification belongs in the
  follow-on and needs its own test corpus.
