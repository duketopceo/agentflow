# External submissions — state tracker

| Registry | Action | State | Link |
|---|---|---|---|
| cline/marketplace | `registry/skills/agentflow/entry.json` PR from fork `duketopceo/af-cline-marketplace` (`npm run validate` passed: 204 entries) | PR open | https://github.com/cline/marketplace/pull/224 |
| block/agent-skills (Goose) | **repo archived** — superseded by the universal skills registry | not needed | `npx skills add duketopceo/agentflow` verified live 2026-10-11 (finds `skills/agentflow/SKILL.md`) |
| cursor.directory | self-serve listing | **✅ live** 2026-10-13 — auto-scan pulled MCP server, worker agent, skill, deep-research command | https://cursor.directory/plugins/agentflow |
| cursor.com/marketplace/publish | official curated listing | **application submitted** 2026-10-13 — manual review via marketplace-publishing@cursor.com | https://cursor.com/marketplace/publish |
| npm registry | `@lukedaduke/agentflow` | **✅ published 0.2.0** 2026-10-17 — granular token via web session; `release.yml` adds OIDC trusted-publishing path (npm-side key-tap pending) + `npm` env w/ required reviewer | https://www.npmjs.com/package/@lukedaduke/agentflow |

## Notes

- The cline entry sets `verified: false` — verification is a maintainer call.
- Forks `duketopceo/af-cline-marketplace` and `duketopceo/af-goose-skills` can
  be deleted once the PR resolves (the goose fork carried no PR — repo was
  archived before submission).
