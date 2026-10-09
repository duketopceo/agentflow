# Research: orchestration economics — what works, what it costs, what caches

Companion to `cross-harness-dynamic-workflows.md`. Pricing pulled live from
`openrouter.ai/api/v1/models` on 2026-10-09; papers verified by abstract/source.

## 1. What the literature says actually works

| Paper / source | Core finding for our design |
|---|---|
| **Google, "Towards a Science of Scaling Agent Systems"** (arXiv:2512.08296, 180–260 configs) | Multi-agent wins **+80.8%** on decomposable tasks but **−70%** on sequential planning. Independent agents amplify errors **17.2×**; centralized coordination contains to ~4× — **always funnel through a synthesis/verify stage**. Capability saturation ~45%: if a strong single agent already passes, coordination hurts. Tool-heavy tasks suffer multi-agent overhead. |
| **Anthropic, "How we built our multi-agent research system"** (engineering blog) | Token usage explains ~80% of BrowseComp variance; agents use ~4× chat tokens, full MAS ~15×. The mechanism IS spending more tokens in parallel contexts — so worker-tier price is the dominant knob. Sub-agents are for wide/parallel problems, not narrow/sequential ones. |
| **Anthropic Managed Agents cookbook (PR 754)** | Frontier coordinator + cheap scoped workers: **2.5× cheaper, 3× faster** than one frontier agent at matched rigor ($1.61 vs $4.00); 84% of spend billed at the worker rate. Per-worker fixed setup floor → brief granularity has an optimum (don't over-split). |
| **MAST — "Why Do Multi-Agent LLM Systems Fail?"** (NeurIPS D&B 2025, arXiv:2503.13657) | 14 failure modes in 3 buckets: spec, inter-agent misalignment, **task verification**. Multi-agent gains are often minimal vs single-agent or best-of-N unless verification is engineered in — our adversarial-verify phase exists precisely because of this. |
| **AFlow** (ICLR 2025 Oral, arXiv:2410.10762, github.com/FoundationAgents/AFlow) | Workflows as **code**, searched by MCTS with execution feedback — +5.7% over SOTA; small models beat GPT-4o at **4.55% of its cost**. Validates our script-as-plan representation and points at `agentflow` workflow auto-optimization as a future direction. |
| **"The Harness Effect"** (arXiv:2607.06906) | Same models, swap orchestration layer: −41% cost/task, −38% tokens, quality parity. Orchestration moved cost more than switching cheapest↔most-expensive model — the harness IS the cost lever, which is what agentflow is. |
| **Mixture-of-Agents** (arXiv:2406.04692) | Layered propose→aggregate beats single SOTA with open models — the shape of our research→verify→synthesize phases. |
| **"More Agents Is All You Need"** (arXiv:2402.05120) | Sampling-and-voting scales log-ish with agents — cheap models + N samples + vote is a legitimate alternative to one strong call. |
| **Cognition, "Don't Build Multi-Agents"** (Walden Yan, 2025) | The counter-argument: shared-context multi-agents fragment context and contradict each other. Agentflow's design threads the needle — fresh-context workers + explicit prompt-passed data, no shared mutable context, everything reconciles in a single synthesis agent. |
| Field reports | 90-day MAS report (GH discussion): sweet spot ≈3 parallel workers + 1 QA gate; context re-injection was the surprise cost; fixed per-worker setup floor argues against over-splitting. |

## 2. Cost model (20-agent run: decompose + 14 workers + 4 verify + synth)

Token profile per `agent()` call — light ≈20k in/2k out (classify/extract),
typical ≈80k in/5k out (researcher w/ a few tool calls), heavy ≈300k in/15k
out (agentic sweep). Prices $/Mtok, live from OR API.

| Model (slug) | in/out | light | typical | heavy |
|---|---|---|---|---|
| `z-ai/glm-5.3-flash` | 0.15 / 0.50 | $0.08 | **$0.29** | $1.05 |
| `deepseek/deepseek-v4.1-flash` | 0.30 / 1.20 | $0.13 | $0.82 | $3.06 |
| `openai/gpt-6-luna` | 0.10 / 0.50 | $0.06 | **$0.28** | $0.90 |
| `deepseek/deepseek-v4-flash-latest`* | 0.005 / 0.184 | $0.01 | **$0.03** | $0.11 |
| `openai/gpt-5.6-terra` | 2.00 / 12.00 | $0.80 | $5.80 | $15.60 |
| devin `claude-haiku-5-5-low` | 0.10 / 0.50 | $0.06 | $0.28 | $0.90 |
| devin `swe-2-*` | free tier | $0 | $0 | $0 |
| claude sonnet native (~3/15) | 3.00 / 15.00 | $1.30 | $6.30 | $22.50 |

\* `~latest`-suffixed rows are OR routing aliases — pin exact slugs in scripts.

**Reading it:** the orchestrator's model price barely matters (1–3 calls);
the worker tier × N is everything. A 20-agent deep-research on glm-5.3-flash
or gpt-6-luna ≈ **$0.30**; the same shape on frontier workers ≈ **$6+**. Use
terra/sol/sonnet only for the synthesis call — it sees the most context.

## 3. Batch models — verified dead end for agent loops

`:batch` slugs exist for most models at ~40–60% off (`glm-5.3-flash:batch`
0.06/0.20, `deepseek-v4.1-flash:batch` 0.112/0.336, `gpt-6-luna:batch`
0.05/0.25, `gpt-oss-120b:batch` 0.03/0.136). **Verified rejection**:
`z-ai/glm-5.3-flash:batch` 404s on `/chat/completions` (DeepInfraBatchAdapter) —
OR batch variants are a separate async jobs API, unusable inside `ori code`
or any chat-completions loop. Possible future `agentflow` surface: a batch
job adapter for latency-tolerant pure-LLM stages.

## 4. Caching — the honest answer

| Layer | What's shared | Win |
|---|---|---|
| Provider prefix cache | the harness's system prompt across workers (~10–30k tok/session) | Real but bounded: `cache_read` prices run ~10–50% of input (deepseek 0.5×, anthropic ~0.1×, glm ~0.2×). Only the shared prefix hits — each worker's unique context doesn't. |
| Journal + `--resume` | settled results survive interrupts | Already built — zero re-spend on replay. |
| **`--cache` memoization** | identical (harness, model, prompt, schema, via, cwd, permission) calls across *any* run | **Now built** — `.agentflow/cache/<sha>.json`; content-keyed so it survives script reordering where positional `--resume` breaks. Dev-loop win: iterate on phase 3 without re-spending phases 1–2. Failed calls never cache. |
| `:batch` pricing | latency-tolerant calls | Not caching, but ~50% off — blocked on OR's separate batch API (see §3). |

So: yes, "not a lot" for unique work — but the system-prompt prefix +
memoization + resume already cover the repeatable spend. `--cache` is the
big one for iterative workflow development.

## 5. New `openrouter` adapter — the real cost lever

`--harness openrouter` calls `/chat/completions` directly — no subprocess, no
agent loop, no tools. Most workflow stages (decompose, classify, verify prose,
synthesize) don't need tools: they get a 1M-ctx cheap model at ~$0.01–0.05/call
with zero CLI startup. Reserve harness adapters for stages that touch the
filesystem. `spec.model` = full OR slug; `spec.reasoningEffort` →
`reasoning.effort`. Requires `OPENROUTER_API_KEY` in env (`ori`'s stored
credential is not exported to arbitrary processes; per workspace convention,
eval spend routes through the `openrouter/orchestral` omaseal key).

## 6. Recommended configs

```bash
# cheapest real deep-research — tool-free stages on OR, ~$0.30/run
AGENTFLOW_CHEAP_MODEL=z-ai/glm-5.3-flash \
agentflow run workflows/deep-research.mjs --harness openrouter --cache -- "question"

# mixed: research workers on devin swe-2 (free), synthesis on luna
# (script authors route stages by model: per agent() call)

# claude-quality workers on OR billing
agentflow run w.mjs --harness claude --via ori
```

Open question worth a real test run: whether `ori`'s own `code` loop on
`glm-5.3-flash` is good enough at tool use that `--harness ori` beats
`--harness openrouter` for research tasks that need `web_fetch`.
