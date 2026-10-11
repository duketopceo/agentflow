// omaseal:// keyring references — a credential may be given as
// `omaseal://<service>/<account>` anywhere an API key env var is read.
// Resolved via `omaseal resolve` (which fails closed when the store is
// locked or the manifest denies the secret); the value is cached for the
// process lifetime so a fan-out resolves once.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const cache = new Map(); // ref -> Promise<string>

export const OMASEAL_PREFIX = 'omaseal://';

export async function resolveRef(ref, execImpl = execFileP) {
  if (!cache.has(ref)) {
    cache.set(ref, execImpl('omaseal', ['resolve', ref], { timeout: 10_000 })
      .then(({ stdout }) => {
        const key = String(stdout).trim();
        if (!key) throw new Error('omaseal resolve returned empty');
        return key;
      })
      .catch((e) => {
        cache.delete(ref); // do not memoize failures — store may unlock later
        throw e;
      }));
  }
  return cache.get(ref);
}

// Returns the literal key, the resolved keyring value, or null when the
// env is unset or resolution fails (caller keeps its "not set" error path).
export async function apiKey(envValue, { execImpl } = {}) {
  if (!envValue) return null;
  if (!envValue.startsWith(OMASEAL_PREFIX)) return envValue;
  try {
    return await resolveRef(envValue, execImpl);
  } catch {
    return null;
  }
}
