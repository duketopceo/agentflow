---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan user-directed
external_source: microsoft/agent-governance-toolkit (github.com/microsoft/agent-governance-toolkit) — 6.4k★, MIT, Python, pushed recently
---

# govern() evaluation — application-layer policy on worker tool calls

## Goal Capsule

Evaluate Microsoft's agent-governance-toolkit — `govern(fn, policy="policy.yaml")` wrapping tool calls with allow/deny/require-approval rules and a tamper-evident audit log — as the *interception-layer* complement/alternative to runtime sandboxing. Output: verdict on whether tool-call governance belongs in agentflow's worker path.

## Product Contract

### The different threat model

Sandboxing (the sibling plan) restricts what the *process* can do. govern() restricts what the *agent* can *invoke* — policy evaluated per tool call, before execution, with denials raising `GovernanceDenied` and every decision logged. Microsoft's framing: prompt-level safety is probabilistic; code-level interception makes bad actions structurally impossible. OWASP Agentic Top 10 coverage.

### Scope boundaries

- **In:** read the toolkit, wrap a representative agentflow worker tool surface (shell, file-write, network-call) with govern() in a scratch harness, exercise allow/deny/approve paths, verdict doc.
- **Out:** adopting it; the full stack (SPIFFE identity, kill-switch SRE, shadow-AI discovery) — eval the core `govern()` + policy + audit first.
- **Relationship to sandboxing plan:** alternatives on the same attack surface; the two plans must reconcile — the verdict doc names which layer owns which defense (likely: govern for tool-call policy + approval gates, sandbox for the subprocess boundary).

### Requirements

1. Scratch wrap: pick one agentflow worker tool path (`src/` shell/exec call, or a worker-invoked MCP tool); apply `govern()` with a YAML policy — deny `rm -rf`, deny network to non-allowlisted hosts, `require_approval` on writes outside the worktree.
2. Exercise the approval path — a denied-by-default action surfaces as an approval request, not a crash.
3. Audit log: verify tamper-evident trail records decision + inputs per call.
4. Verdict doc `docs/decisions/policy-interception-eval.md`: adopt as interception layer | skip (sandboxing covers it) | adopt the *pattern* (own thin wrapper) without the toolkit.
5. If adopt: note Python-interop reality — agentflow is Node (`src/*.mjs`); govern() is Python-first (has TS SDK — check its maturity; if immature, the pattern is borrowable without the lib).

### Acceptance examples

- Deny rule fires: worker attempt at `rm -rf` outside worktree → `GovernanceDenied`, logged, no partial execution.
- require_approval pauses correctly and resumes on grant.
- Audit log survives process restart and is verifiable.

## Repo Touchpoints

- `docs/decisions/policy-interception-eval.md` (new)
- `src/` — only if verdict = adopt (follow-on)

## Test Scenarios

1. allow → executes; deny → blocked + logged; require_approval → pending → approved → executes.
2. Bypass test: worker calls a *non-wrapped* code path — document that govern() sees only wrapped calls (the known blind spot vs runtime sandboxing).
3. TS-SDK viability check on Node 20+.

## Risks / Honest Notes

- The blind spot is structural: anything outside wrapped functions is invisible. A worker spawning a subprocess around the wrap defeats it — which is why this complements, not replaces, process-level isolation.
- MIT, Microsoft-maintained, cross-framework adapters (LangGraph/CrewAI/OpenAI-Agents/ADK/smolagents/Claude-Code plugin). Lowest-risk heavyweight of the three security candidates.
- If both this and sandboxing are adopted, define the layering once: **govern = intent policy, sandbox = capability boundary.** Write that sentence in the doc.
