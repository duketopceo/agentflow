import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';

export async function which(bin) {
  if (isAbsolute(bin)) {
    try { accessSync(bin, constants.X_OK); return bin; } catch { return null; }
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = `${dir}/${bin}`;
    try { accessSync(p, constants.X_OK); return p; } catch {}
  }
  return null;
}
