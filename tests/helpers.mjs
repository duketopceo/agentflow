import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';

export const FAKEBIN = fileURLToPath(new URL('./fakebin', import.meta.url));

// Run fn with tests/fakebin prepended to PATH. spawnProcess defaults env to
// process.env at call time, so no runtime seam is needed — the fake binaries
// resolve first for the duration of the call. `env` merges extra env vars
// (the stubs' FAKEBIN_* knobs); PATH and env are restored in finally.
export async function withFakebin(fn, env = {}) {
  const saved = { PATH: process.env.PATH };
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    process.env.PATH = `${FAKEBIN}${delimiter}${saved.PATH}`;
    Object.assign(process.env, env);
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export const spec = (over = {}) => ({ prompt: 'review this file', label: 't', ...over });

// Portable long-running child: [cmd, args] for child_process.spawn.
export const sleepBin = process.platform === 'win32' ? 'node' : 'sleep';
export const sleepCmd = (secs) => process.platform === 'win32'
  ? [process.execPath, ['-e', `setTimeout(() => {}, ${secs * 1000})`]]
  : ['sleep', [String(secs)]];
