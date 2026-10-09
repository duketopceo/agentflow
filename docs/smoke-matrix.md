# Live adapter smoke matrix — v0.2

Run 2026-10-09 from `/tmp/af-smoke` (isolated scratch dir; journals under
`.agentflow/`). Invocation: `agentflow run smoke.mjs --harness <h> -- <model>`.
Cost posture: free/cheap routes only — no Anthropic or premium spend.

| Harness | Invocation | Result | Latency | Spend |
|---|---|---|---|---|
| devin | `--harness devin -- swe-2-medium` | PONG | 11.2s | free (swe-2 tier) |
| ori | `--harness ori -- z-ai/glm-5.3-flash` | PONG | 4.0s | $0.00006 (ori reports per-call) |
| openrouter | `--harness openrouter -- z-ai/glm-5.3-flash` | PONG | 1.5s | ~$0.00005 direct API, no subprocess |
| claude (via ori) | `--harness claude --via ori -- z-ai/glm-5.3-flash` | PONG | 17.8s | OpenRouter key |
| codex (via ori) | `--harness codex --via ori -- z-ai/glm-5.3-flash` | PONG | 22.6s | OpenRouter key |
| opencode (via ori) | `--harness opencode --via ori -- z-ai/glm-5.3-flash` | PONG | 18.9s | opencode's stored OpenRouter credential |
| echo | `--harness echo` | n/a | — | free, test-only |

## Findings this matrix produced

- **codex custom spawnAgent bypassed `applyVia`** — `--via ori` never wrapped
  codex; it ran bare `codex exec -m <or-slug>` → exit 1. Fixed by applying
  `applyVia` inside codex.mjs.
- **`ori codex` consumes `--model` itself** and forwards the rest; codex's
  session header still labels provider `openai` (generic OpenAI-compatible
  label) while requests route to OpenRouter. Verified working.
- **opencode global config was invalid** (`mcp.kurultai-personal` used
  `type: stdio` + string `command` + separate `args`, missing `enabled`) —
  opencode refused to start. Repaired to `type: local` with merged command
  array (backup at `opencode.json.bak-agentflow`).
- **opencode's stored OpenRouter key shadows Ori's injected key** — ori warns
  but the run succeeds on the stored credential. Documented behavior, not a
  bug; removing the stored key would flip billing to Ori's credential.
- **`swe-2-medium`/`swe-2-high`/`swe-2-max` are the free devin models**
  (there is no `swe-2-lite`); `claude-haiku-5-5-low` remains the cheap paid pin.
- **codex prints `Reading additional input from stdin...`** with piped stdin —
  harmless; `stdio: ['ignore']` gives it EOF and it proceeds.

## End-to-end: deep-research on openrouter/glm-5.3-flash

`agentflow run deep-research.mjs --harness openrouter` (all stages glm):
decompose (6 sub-questions) → 5/6 researchers returned → adversarial
cross-check → synthesis. ~308s wall, ~12 calls, ~$0.003 total spend.

**Finding:** `z-ai/glm-5.3-flash` intermittently returns `empty completion`
under burst concurrency (5 of 12 calls) — the runner journals them as failed
(`null`) and the workflow degrades gracefully, but cheap-model flakiness is
real. A `retries` spec opt or automatic single-retry-on-empty is a candidate
follow-up; `--cache` + `--resume` already bound re-run cost.
