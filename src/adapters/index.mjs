import echo from './echo.mjs';
import devin from './devin.mjs';
import claude from './claude.mjs';
import codex from './codex.mjs';
import opencode from './opencode.mjs';
import ori from './ori.mjs';

export const adapters = { echo, devin, claude, codex, opencode, ori };

export function getAdapter(name) {
  return adapters[name] ?? null;
}
