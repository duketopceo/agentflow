import { accessSync, statSync, constants } from 'node:fs';
import path from 'node:path';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

// Candidate file names for `bin` on Windows: if it already ends in a PATHEXT
// extension, the bare name first; then bin + each PATHEXT ext; then the bare
// name (extensionless files are not directly spawnable but are still found).
export function winCandidates(bin, pathext) {
  const exts = (pathext || DEFAULT_PATHEXT).split(';').map((e) => e.trim()).filter(Boolean);
  const lower = bin.toLowerCase();
  const hasExt = exts.some((e) => lower.endsWith(e.toLowerCase()));
  const out = hasExt ? [bin] : [];
  for (const e of exts) out.push(bin + e);
  if (!hasExt) out.push(bin);
  return out;
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

// Resolve `bin` to an executable path, or null. `opts` is a test seam
// (platform/env/exists). POSIX behavior is unchanged: join with '/' and X_OK.
// On win32: split PATH on ';', join with win32 separators, try each PATHEXT
// extension, and use plain existence (there is no X_OK on Windows).
export async function which(bin, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform === 'win32') {
    const p = path.win32;
    const exists = opts.exists ?? isFile;
    const names = winCandidates(bin, env.PATHEXT ?? env.Pathext);
    if (p.isAbsolute(bin) || /[\\/]/.test(bin)) {
      for (const n of names) if (exists(n)) return n;
      return null;
    }
    for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
      const d = dir.trim().replace(/^"(.*)"$/, '$1');
      if (!d) continue;
      for (const n of names) {
        const full = p.join(d, n);
        if (exists(full)) return full;
      }
    }
    return null;
  }
  if (path.isAbsolute(bin)) {
    try { accessSync(bin, constants.X_OK); return bin; } catch { return null; }
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    const full = `${dir}/${bin}`;
    try { accessSync(full, constants.X_OK); return full; } catch {}
  }
  return null;
}
