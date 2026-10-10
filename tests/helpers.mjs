import { fileURLToPath } from 'node:url';

export const FAKEBIN = fileURLToPath(new URL('./fakebin', import.meta.url));

// Run fn with tests/fakebin prepended to PATH. spawnProcess defaults env to
// process.env at call time, so no runtime seam is needed — the fake binaries
// resolve first for the duration of the call. Restores PATH in finally.
export async function withFakebin(fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${FAKEBIN}:${saved}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

export const spec = (over = {}) => ({ prompt: 'review this file', label: 't', ...over });
