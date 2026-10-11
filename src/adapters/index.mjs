import echo from './echo.mjs';
import devin from './devin.mjs';
import claude from './claude.mjs';
import codex from './codex.mjs';
import opencode from './opencode.mjs';
import ori from './ori.mjs';
import openrouter from './openrouter.mjs';
import perplexity from './perplexity.mjs';
import openai from './openai.mjs';
import anthropic from './anthropic.mjs';

export const adapters = { echo, devin, claude, codex, opencode, ori, openrouter, perplexity, openai, anthropic };

export function getAdapter(name) {
  return adapters[name] ?? null;
}
