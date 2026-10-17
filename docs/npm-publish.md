# npm publish — done

**Published (2026-10-17):** [`@lukedaduke/agentflow@0.2.0`](https://www.npmjs.com/package/@lukedaduke/agentflow)
— install-verified (`npm i @lukedaduke/agentflow` + `agentflow --version`
in a scratch dir). Published via a granular access token
(`agentflow-publish`, bypass-2FA, read+write, all packages, 30-day expiry)
minted through the BrowserOS neo web session after the account suspension
lifted.

**Decision (2026-10-13):** published name is **`@lukedaduke/agentflow`** —
the bare `agentflow` is rejected by npm's similarity guard (`403: too
similar to existing package agent-flow`). The `agentflow` CLI binary name
is unchanged; `npm i -g @lukedaduke/agentflow` installs `agentflow` on PATH.
`@duketopceo/agentflow` is NOT an option — npm username is `lukedaduke`,
there is no `duketopceo` npm user or org.

**Auth notes:** login via password + a recovery code — the stored `Npmjs`
keyring entry is the password, not a token. npm account 2FA is **WebAuthn
security key**, not TOTP — recovery codes pass web login but are rejected
by CLI `--otp`. npm's suspension is a **rolling cooldown that re-arms on
any security-sensitive action** (each recovery-code login reset it); token
minting works only inside a lifted window. Token creation also demands a
fresh step-up — "Confirm password" path works without the security key.
npm ref-clicks intermittently no-op on auth/settings pages — DOM `.click()`
via evaluate is the reliable fallback.

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
