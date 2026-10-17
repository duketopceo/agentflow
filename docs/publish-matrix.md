# Publish matrix — top agent-harness distribution surfaces

Status of agentflow's plugin/skill packaging across the main agent harnesses,
and the exact path to being *officially published* (registry, marketplace, or
crawled directory) in each. Last audited 2026-10-11.

## The top 10

| # | Harness | Surface | Repo artifact | Official publish path | Status |
|---|---|---|---|---|---|
| 1 | **Devin** | plugins | `.devin-plugin/plugin.json` | GitHub repo IS the install — `devin plugins install duketopceo/agentflow`; no central curated store | ✅ live-verified |
| 2 | **OpenCode** | plugins (v1 + v2) | `plugins/agentflow/{v1,v2}.mjs` + `exports["./server"\|"./v2"]` | `opencode plugin github:duketopceo/agentflow` (v1) / `#main::path:` (v2) | ✅ v1 + v2 both live-verified (v2 on `opencode-ai@beta` build — plugin loads, tools register + execute) |
| 3 | **Claude Code** | plugin marketplaces | `.claude-plugin/{plugin,marketplace}.json` | `claude plugin marketplace add duketopceo/agentflow` then `claude plugin install agentflow@agentflow`; MCP via `claude mcp add agentflow --scope user -- agentflow mcp` (plugin-bundled `.mcp.json` not auto-registered — verified) | ✅ live-verified (marketplace + plugin install + `mcp get` shows Connected) |
| 4 | **Codex** | plugin marketplaces | `.codex-plugin/plugin.json` | `codex plugin marketplace add duketopceo/agentflow` then `codex plugin add agentflow@agentflow`; MCP via `codex mcp add agentflow -- agentflow mcp` | ✅ live-verified (marketplace + plugin add + mcp registered) |
| 5 | **Factory Droid** | plugins + droids | `.factory-plugin/plugin.json` + `droids/worker.md` (`.claude-plugin/` also auto-translates) | `droid plugin marketplace add duketopceo/agentflow` | ✅ live-verified: `plugin install agentflow@agentflow` → Active `[user]` (droid 0.244.0, 2026-10-17) |
| 6 | **Copilot CLI** | plugins (Agent Plugins 1.0) | root `plugin.json` carries `$schema`; `skills/` dir discovered | `copilot plugin install duketopceo/agentflow` — plugin-bundled `.mcp.json` is NOT auto-registered; MCP via `copilot mcp add agentflow -- agentflow mcp` | ✅ install-verified + mcp registered (2026-10-11) |
| 7 | **Cursor** | plugins (native + Agent Plugins) | `.cursor-plugin/plugin.json` (native) + root `plugin.json` (standard) | Official: cursor.com/marketplace/publish application **submitted** (manual review). Community: **[cursor.directory/plugins/agentflow](https://cursor.directory/plugins/agentflow)** | ✅ live on cursor.directory; official listing under review |
| 8 | **Gemini CLI** | extensions | `gemini-extension.json` at root + `gemini-cli-extension` repo topic (set) | `gemini extensions install <repo>` — also crawls topic into geminicli.com registry | ✅ **live-verified**: `extensions link` + `mcp list` shows `agentflow … Connected` (2026-10-11) |
| 9 | **Cline** | skills/plugins/MCP marketplace | `registry/skills/agentflow/entry.json` | PR to `cline/marketplace` → publishes to catalog | 🟡 PR open: [cline/marketplace#224](https://github.com/cline/marketplace/pull/224) (validated 204 entries) |
| 10 | **Goose (Block)** | universal skills registry | `skills/agentflow/SKILL.md` | `npx skills add duketopceo/agentflow` (block/agent-skills archived — superseded) | ✅ install-verified via `npx skills` (2026-10-11) |
| 11 | **Any MCP client** (Crush, Zed, Claude Desktop, Roo, Kilo, Kiro, Windsurf…) | MCP stdio | `.mcp.json` + `agentflow mcp` | `{"agentflow": {"command": "agentflow", "args": ["mcp"]}}` in the client's mcp config | ✅ stdio contract suite-tested; Gemini+Crush wired live |
| 12 | **npm** | package registry | `package.json` (`@lukedaduke/agentflow`, bin `agentflow`) | granular access token (bypass-2FA, publish+stage) → `npm publish --access public` | ✅ **published 0.2.0** — [npmjs.com/package/@lukedaduke/agentflow](https://www.npmjs.com/package/@lukedaduke/agentflow); install-verified (2026-10-17) |

## Publish-ready artifacts (shipped)

- `agentflow mcp` — zero-dep stdio MCP server (`src/mcp.mjs`): `agentflow_run`/`doctor`/`status`/`tail`/`stop`
- `.mcp.json` at root → canonical server block; `.claude-plugin/` + `.codex-plugin/` reference it; `.cursor-plugin/`, `.factory-plugin/`, `gemini-extension.json` carry it inline
- root `plugin.json` → `$schema` Agent Plugins 1.0 → satisfies Copilot CLI AND Cursor's open-standard path (`skills/` discovered by directory convention — a `skills` field is rejected by the schema)
- `gemini-extension.json` → `{name, version, description, contextFileName}` — skill content via context file
- `.factory-plugin/plugin.json` + `droids/worker.md` → native Droid instead of compat translation
- `.cursor-plugin/plugin.json` → native Cursor (rules/skills/agents fields)
- GitHub repo topics set: `gemini-cli-extension`, `claude-code-plugin`, `opencode-plugin`, `cursor-plugin`, `agent-orchestration`, `multi-agent`

## External submissions (need an outward action)

- `cline/marketplace` — fork, add `registry/skills/agentflow/entry.json`, PR
- `block/agent-skills` — fork, add `skills/agentflow/` folder, PR (auto-validated)
- `cursor.directory` — submit repo URL (community, faster than cursor.com review)
- `cursor.com/marketplace/publish` — official curated listing (manual review, email follow-up)
- `awesome-opencode` / `awesome-claude-plugins` list PRs for discoverability

## No real surface (skip)

- **Aider** — no plugin system; docs-only
- **Crush** — MCP config only; covered by a future `agentflow mcp` server
- **Zed** — extensions are WASM (themes/languages/ACP agent-servers); an ACP surface is a real but large lift
- **Roo/Kilo, Kiro, Warp, Jules** — no compatible plugin surface today
- **Ori** — already covered: `--via ori` wraps CLI workers
