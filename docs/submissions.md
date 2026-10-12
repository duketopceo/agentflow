# External submissions — state tracker

| Registry | Action | State | Link |
|---|---|---|---|
| cline/marketplace | `registry/skills/agentflow/entry.json` PR from fork `duketopceo/af-cline-marketplace` (`npm run validate` passed: 204 entries) | PR open | https://github.com/cline/marketplace/pull/224 |
| block/agent-skills (Goose) | **repo archived** — superseded by the universal skills registry | not needed | `npx skills add duketopceo/agentflow` verified live 2026-10-11 (finds `skills/agentflow/SKILL.md`) |
| cursor.directory | self-serve listing | **manual step** | submit repo URL + description below at https://cursor.directory |
| cursor.com/marketplace/publish | official curated listing | optional follow-up | manual review flow |

## cursor.directory submission (manual — web form)

- **Repo URL:** `https://github.com/duketopceo/agentflow`
- **Name:** agentflow
- **Tagline:** Cross-harness dynamic workflows — fan out work to pooled
  fresh-context agents with journaled results and resume.
- **Category:** plugins / MCP (repo carries `.cursor-plugin/` + `.mcp.json`)
- **Install note:** `cursor plugin` reads `.cursor-plugin/`; the MCP server
  (`agentflow mcp`) is wired in the plugin manifest and the root `.mcp.json`.

## Notes

- The cline entry sets `verified: false` — verification is a maintainer call.
- Forks `duketopceo/af-cline-marketplace` and `duketopceo/af-goose-skills` can
  be deleted once the PR resolves (the goose fork carried no PR — repo was
  archived before submission).
