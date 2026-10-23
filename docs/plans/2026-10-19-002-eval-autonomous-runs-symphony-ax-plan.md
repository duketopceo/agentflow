---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan user-directed
external_sources:
  - openai/symphony (github.com/openai/symphony) — 27.7k★, Apache-2.0, Elixir, last push 2026-09-15
  - google/ax (github.com/google/ax) — 14k★, Apache-2.0, Go, pushed 2026-10-19 (+ agent-substrate/substrate)
---

# Autonomous-runs study — Symphony spec + AX vocabulary → agentflow ADR

## Goal Capsule

Read OpenAI Symphony's `SPEC.md` and Google's AX manifest model, diff them against agentflow's journaled fan-out + Kurultai Hey board, and write an ADR capturing which primitives agentflow should borrow — and which it shouldn't. Analysis plan: the deliverable is a document, not code.

## Product Contract

### Why these two

- **Symphony** is the closest corporate analog to agentflow: monitor a work board (Linear), spawn agents per task in isolated runs, agents return **proof of work** (CI status, PR review feedback, complexity analysis, walkthrough videos) instead of being supervised. "Manage work, not agents." Released spec-first — SPEC.md is the artifact, the Elixir impl is optional reference.
- **AX** contributes vocabulary: `Task` / `Workspace` / `Model` as declarative manifests, `watch`/`ssh`/`suspend`/`resume` lifecycle on sandboxed agent tasks. The K8s substrate is Google-scale overkill — the *manifest semantics* are the portable part.

### The diff to write

| Primitive | Symphony | AX | agentflow today |
|---|---|---|---|
| Work source | board (Linear) | manifest apply | journal + Hey posts |
| Unit | isolated run | Task/Workspace actor | worker fan-out |
| Completion | proof-of-work bundle | task status | settled journal line |
| Supervision | none — proof replaces it | watch/ssh/suspend/resume | tail/watch |

### Scope boundaries

- **In:** read SPEC.md + AX docs, produce `docs/adr/` (or `docs/decisions/`) entry mapping each primitive to adopt/adapt/reject for agentflow, with rationale.
- **Out:** implementing any of it; K8s/Substrate (explicitly rejected — laptop workload); evaluating Symphony's Elixir impl code quality (stale since Sep 15 — treat the spec as the product).

### Requirements

1. Read `SPEC.md` fully; extract the proof-of-work contract precisely (what must an agent return to count as "done"?).
2. Read AX manifest schema (`ax.io/v1alpha1` Task/Workspace/Model) — note suspend/resume semantics: checkpoint idle agents, resume later.
3. Map onto agentflow: what does our journal entry lack vs Symphony's proof-of-work? What would a `Workspace` manifest give us that worktrees don't? Is suspend/resume worth anything on a single box (probably: checkpoint long-running workers)?
4. Bonus worth capturing: Symphony's *release model* — spec + optional reference impl — is itself a pattern agentflow could use (the journal/runner is already spec-able).
5. Output: `docs/decisions/autonomous-runs-study.md` — adopt/adapt/reject table + the one-paragraph "if we borrow one thing" conclusion.

### Acceptance examples

- The doc names at least one concrete change candidate for agentflow (or defensibly concludes "none — ours is better for a single-box tool" with reasons).
- Proof-of-work definition from the spec is quoted, not paraphrased.

## Repo Touchpoints

- `docs/decisions/autonomous-runs-study.md` (new)
- `DESIGN.md` / `ROADMAP.md` referenced in the writeup where relevant

## Test Scenarios

None — analysis artifact. Acceptance = the doc exists, cites primary sources, and renders a verdict.

## Risks / Honest Notes

- Ideas have no forcing function; a study that ends "interesting" is worthless. The acceptance bar is a *decision* with named adopt/adapt/reject per primitive.
- Symphony stale since Sep 15 — spec is stable, but don't assume the Elixir impl tracks it.
- The likeliest borrow: proof-of-work as the journal's completion contract (a run isn't "done" until it returns CI status / diff / review state — not just exit code). Suspend/resume is the most interesting *reject* candidate — real on a fleet, marginal on one box.
