# npm publish — decided, blocked on auth token

**Decision (2026-10-11):** agentflow WILL be published to npm. Both names
verified unclaimed (re-checked 2026-10-13): `npm view agentflow` → 404,
`npm view @duketopceo/agentflow` → 404. Prefer the bare `agentflow` name —
install UX (`npm i -g agentflow`) matches the CLI's own name.

**Auth state (2026-10-13):** publish attempted and blocked — npm no longer
accepts password auth anywhere (legacy CLI login, `/-/npm/v1/tokens`, web
login all dead ends; the `.npmrc` token on omarchy-max is expired → E401).
What is needed, one of:

- `npm login` in a terminal (web flow → writes a fresh `_authToken`), or
- a **granular/classic token** with publish permission from
  https://www.npmjs.com/settings/duketopceo/tokens — pass it to an agent or
  `omaseal set Npmjs token` so `omaseal_resolve` finds it later.

With a token: `NPM_TOKEN=<t> npm publish --access public --userconfig <rc>`,
where the rc contains `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`.

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
