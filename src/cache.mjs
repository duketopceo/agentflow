import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Content-addressed result memoization, distinct from --resume's positional
// replay: a cache hit survives script reordering, and reuse is explicit opt-in
// (`--cache`) since an identical prompt can intentionally want fresh results.
export function cacheKey(adapterName, spec) {
  const h = createHash('sha256');
  h.update(JSON.stringify([adapterName, spec.model ?? null, spec.via ?? null, spec.permission ?? null, spec.cwd ?? null, spec.schema ?? null, spec.prompt]));
  return h.digest('hex').slice(0, 32);
}

export function cacheDir(cwd) {
  return join(cwd, '.agentflow', 'cache');
}

export function cacheRead(cwd, key) {
  const p = join(cacheDir(cwd), `${key}.json`);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')).result;
  } catch {
    return undefined;
  }
}

export function cacheWrite(cwd, key, result) {
  const dir = cacheDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({ result, at: new Date().toISOString() }));
}
