---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan user-directed
external_sources:
  - anthropics/sandbox-runtime (5.6k★, Apache-2.0, TypeScript, pushed 2026-10-20)
  - NVIDIA/OpenShell (16.7k★, Apache-2.0, Rust, pushed 2026-10-20)
  - stripe/smokescreen (1.4k★, MIT, Go, pushed 2026-10-19 — egress option)
---

# Worker sandboxing decision — how much isolation do workers get

## Goal Capsule

Decide how agentflow workers (and concurrent agent sessions generally) get isolated: lightweight userspace restriction (`sandbox-runtime`), full kernel-enforced sandbox+gateway (`OpenShell`), or egress-only control now (`smokescreen`) with runtime sandboxing deferred. One decision plan — these are alternatives, not additives.

## Product Contract

### The problem

agentflow workers run generated code and touch real resources — files, network, credentialed MCP tools — with the full ambient authority of the user session. Fan-out makes it N concurrent untrusted-ish processes. Today: zero isolation boundary.

### The candidates

| | sandbox-runtime | OpenShell | smokescreen |
|---|---|---|---|
| Boundary | userspace fs/net restrictions | kernel-enforced per-syscall + gateway | egress-only CONNECT proxy |
| Weight | wrap a command | control plane (sandbox+gateway+policy lang) | one Go binary + ACL file |
| Credentials | ambient (real tokens visible) | injected at gateway — agents never hold real tokens | doesn't see creds |
| aarch64 risk | low (TypeScript/OS APIs) | unverified — gate item | low (Go) |
| Telemetry | — | anonymous, on by default (opt-out env) | none |
| Bonus | — | formal verification of policy diffs | per-client ACLs via mTLS identity; SSRF-grade IP blocking |

OpenShell's credential-injection model is the interesting end-state: same philosophy as mcp-oauth-broker (agents never hold raw tokens) extended to every secret.

### Scope boundaries

- **In:** verify each candidate on aarch64/Asahi (hard gate), minimal smoke test wrapping a worker run, decision doc on which layer(s) ship and in what order.
- **Out:** production rollout, policy authoring beyond a trivial allowlist, sandboxing non-agent processes.

### Requirements

1. aarch64 gate first: `sandbox-runtime` install + trivial deny-test; OpenShell support-matrix check (their docs list Linux+Docker — Asahi podman/docker status needs verification). If OpenShell can't run on this box, the decision collapses to sandbox-runtime + smokescreen.
2. Threat-model sentence the decision must answer: are we defending against (a) buggy/hallucinated destructive commands, (b) prompt-injected workers doing exfiltration, or (c) both? (a) → sandbox-runtime suffices; (b) → needs egress control (smokescreen) or OpenShell's gateway.
3. Smoke test: wrap one real agentflow worker invocation in the winner; prove (i) it can still do its job inside the boundary, (ii) a denied action (write outside worktree / fetch a non-allowlisted host) is blocked.
4. Decision doc `docs/decisions/worker-sandboxing.md` with the matrix + chosen order.

### Acceptance examples

- A worker run completes normally inside the boundary (no functionality loss).
- A seeded bad command (`curl evil.example` / `rm` outside worktree) is denied at the layer chosen.
- The doc names the deferred layer explicitly ("smokescreen now, OpenShell when X") rather than leaving it vague.

## Repo Touchpoints

- `docs/decisions/worker-sandboxing.md` (new)
- `src/pool.mjs` / worker spawn path — where the wrap lands (follow-on work after decision)

## Test Scenarios

1. aarch64 install for each candidate — record blockers verbatim.
2. Inside-boundary normal op: worker edits files in its worktree, runs tests — passes.
3. Boundary hit: denied write / denied egress — verify the deny is enforced at the claimed layer.
4. Overhead measure: worker runtime inside vs outside boundary (<10% acceptable for sandbox-runtime).

## Risks / Honest Notes

- OpenShell is the better architecture and the worse first step: control-plane weight, aarch64 unknowns, telemetry opt-out. The honest default is sandbox-runtime + smokescreen now, OpenShell if/when workers touch credentials — which is exactly what the oauth-broker boundary already starts to prevent.
- If ContextForge gateway lands (luke-agents plan), some of OpenShell's value (credential injection, policy) gets partially covered at the MCP layer — the plans interact; the decision doc must say which layer owns what.
- Whatever ships, document the bypass: a user-run command outside the boundary is always possible — this protects agents, not users.
