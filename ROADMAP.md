# Roadmap

Program plan: [docs/plans/2026-10-10-005-feat-program-roadmap-plan.md](docs/plans/2026-10-10-005-feat-program-roadmap-plan.md)
(research: [docs/research/2026-10-10-landscape.md](docs/research/2026-10-10-landscape.md)).
Each unit there carries status, evidence, dependencies, verification, difficulty,
feasibility and a simpler alternative.

| Horizon | Unit | Difficulty |
|---|---|---|
| Now | U1 land M5 deterministic suite + CI (PR #7) | easy |
| Now | U2 land M6 ops parity: stop / clean / `worktree:'auto'` (PR #8) | medium |
| Now | U3 resume replay guard: reject stale results when a prompt changed | medium |
| Now | U4 script-contract parity with Claude workflows (`return`, structured `args`) | medium |
| Now | U5 distribution: npm decision, verified install paths | easy |
| Next | U6 determinism enforced at runtime | easy |
| Next | U7 validated structured output | medium |
| Next | U8 per-agent usage in the journal | medium |
| Next | U9 workflow library from documented patterns | easy |
| Next | U10 single source for plugin manifests | easy |
| Next | U11 refresh dated research docs | easy |
| Later | U12 terminal progress view | medium |
| Later | U13 OpenRouter batch adapter (recommend defer) | hard |
| Later | U14 programmatic API | easy |
| Later | U15 workflow auto-optimisation | hard |

## Earlier plans (design history)

- `docs/plans/2026-10-08-001-feat-agentflow-dynamic-workflows-plan.md` — v0.1 runner
- `docs/plans/2026-10-09-001-feat-agentflow-v02-fusion-plan.md` — v0.2 fusion
- `docs/plans/2026-10-09-002-feat-retries-opt-plan.md` — retries
- `docs/plans/2026-10-09-003-feat-detach-status-plan.md` — detach / status / tail

PRs #7 and #8 additionally add plans 2026-10-10-001 to -004 (M5 to M8).
