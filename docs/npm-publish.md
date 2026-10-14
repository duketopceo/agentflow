# npm publish — decided, blocked on account suspension

**Decision (2026-10-13):** published name is **`@lukedaduke/agentflow`** —
the bare `agentflow` is rejected by npm's similarity guard (`403: too
similar to existing package agent-flow`). The `agentflow` CLI binary name
is unchanged; `npm i -g @lukedaduke/agentflow` installs `agentflow` on PATH.
`@duketopceo/agentflow` is NOT an option — npm username is `lukedaduke`,
there is no `duketopceo` npm user or org.

**Auth state (2026-10-13):** login recovered (`npm whoami` → `lukedaduke`)
via password + a recovery code — the stored `Npmjs` keyring entry is the
password, not a token. npm account 2FA is **WebAuthn security key**, not
TOTP — recovery codes pass web login but are rejected by CLI `--otp`.
A granular publish token (bypass-2FA + read&write) was *one click from
being minted* when npm temporarily suspended the account
("security-sensitive action") — rapid auth attempts tripped anti-abuse.
Resume: tokens page → granular token → `NPM_TOKEN=<t> npm publish
--access public --userconfig <rc>` where rc contains
`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`.

Runbook: `~/.agents/skills/web-auth-recovery/SKILL.md` captures the full
recovery procedure including the pacing rule.

## Why publish

- `command: "agentflow"` in `.mcp.json` and every manifest's `mcpServers`
  block resolves cleanly once `agentflow` is a global install —
  `npx -y @lukedaduke/agentflow mcp` also becomes a zero-install fallback.
- Plugin installs that clone without `npm install` keep working: the MCP
  server and runner are zero-dependency.

## Pre-publish checklist

1. `package.json`: `"name": "@lukedaduke/agentflow"` — done; no `private`
   field; `files` whitelist verified (51 files, ~67.7 kB tarball).
2. `npm pack --dry-run` — eyeball the tarball list.
3. `NPM_TOKEN=<granular> npm publish --access public --userconfig <rc>`.
4. Keep `version` in `package.json`, `plugin.json`, `gemini-extension.json`,
   and `plugins/agentflow/package.json` in lockstep — Gemini's crawler keys
   manifest `version` to the GitHub release tag.

## Post-publish

- Add the npm row to the README install table and `docs/publish-matrix.md`.
- `docs/submissions.md` cursor.directory install note gains the npx path.
