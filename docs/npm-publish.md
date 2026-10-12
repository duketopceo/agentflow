# npm publish — decided, deferred

**Decision (2026-10-11):** agentflow WILL be published to npm; the publish
command stays a manual user action for now. Both names were verified
unclaimed on 2026-10-11: `npm view agentflow` → 404, `npm view
@duketopceo/agentflow` → 404. Prefer the bare `agentflow` name — install UX
(`npm i -g agentflow`) matches the CLI's own name.

## Why publish

- `command: "agentflow"` in `.mcp.json` and every manifest's `mcpServers`
  block resolves cleanly once `agentflow` is a global install —
  `npx -y agentflow mcp` also becomes a zero-install fallback.
- Plugin installs that clone without `npm install` keep working: the MCP
  server and runner are zero-dependency.

## Pre-publish checklist

1. `package.json`: flip `"private": true` → remove or set `false`.
2. Confirm `"files"` whitelist ships only intended payload: `bin`, `src`,
   `skills`, `workflows`, `examples`, `agents`, `commands`, `plugins`,
   `plugin.json`, manifests (`.devin-plugin`, `.claude-plugin`,
   `.codex-plugin`, `.cursor-plugin`, `.factory-plugin`, `.opencode`,
   `gemini-extension.json`, `.mcp.json`, `droids`).
3. `npm pack --dry-run` — eyeball the tarball list.
4. `npm publish --access public` (bare name) — or `--access public` on the
   scoped name if `agentflow` got claimed in the meantime.
5. Keep `version` in `package.json`, `plugin.json`, `gemini-extension.json`,
   and `plugins/agentflow/package.json` in lockstep — Gemini's crawler keys
   manifest `version` to the GitHub release tag.

## Post-publish

- Add the npm row to the README install table and `docs/publish-matrix.md`.
- `docs/submissions.md` cursor.directory install note gains the npx path.
