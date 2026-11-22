import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { which } from './adapters/which.mjs';

// Windows process helpers. Everything here is only reached on win32 (callers
// gate on process.platform); the functions are pure/injectable where possible
// so they can be unit-tested on any OS.

// Kill a process and all its descendants. win32: `taskkill /T /F` (there are
// no process groups). POSIX: signal the group, falling back to the pid.
export function killTree(pid, sig = 'SIGKILL', child = null) {
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      if (r.status === 0) return true;
    } catch {}
    try { (child ?? { kill() {} }).kill(sig); } catch {}
    return false;
  }
  try { process.kill(-pid, sig); return true; }
  catch { try { child ? child.kill(sig) : process.kill(pid, sig); return true; } catch { return false; } }
}

// Lower-cased image name (e.g. 'claude.exe') of a running pid, or null.
export function winImageName(pid) {
  try {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const m = /^"([^"]+)","(\d+)"/m.exec(r.stdout ?? '');
    return m && Number(m[2]) === pid ? m[1].toLowerCase() : null;
  } catch { return null; }
}

// Full command line of a pid on Windows (stand-in for /proc/<pid>/cmdline),
// or null when it cannot be read (then the caller falls back to start time).
export function winCmdline(pid) {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`],
    { encoding: 'utf8', windowsHide: true });
    const s = (r.stdout ?? '').trim();
    return s || null;
  } catch { return null; }
}

// Process start time (epoch ms) of a pid on Windows, via PowerShell.
export function winStartMs(pid) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[DateTimeOffset]::new((Get-Process -Id ${Number(pid)}).StartTime).ToUnixTimeMilliseconds()`],
  { encoding: 'utf8', windowsHide: true });
  const n = Number((r.stdout ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`no start time for pid ${pid}`);
  return n;
}

// Parse an npm/cmd-shim `.cmd` wrapper and return the real target so it can be
// spawned directly (no cmd.exe, so arbitrary prompt text is safe). Returns
// { file, args } or null if the shim is not in the recognised shape.
export function parseCmdShim(shimPath, text) {
  let src = text;
  if (src == null) { try { src = readFileSync(shimPath, 'utf8'); } catch { return null; } }
  const dir = path.win32.dirname(shimPath);
  const re = /^\s*(?:@\s*)?(?:(?:"?%_prog%"?|node(?:\.exe)?|"%dp0%\\node\.exe"|"%~dp0\\node\.exe")\s+)?"?%(?:~dp0|dp0%)\\?([^"\r\n%]+?)"?\s+%\*/gim;
  let m, last = null;
  while ((m = re.exec(src))) last = m;
  if (!last) return null;
  const target = path.win32.join(dir, last[1]);
  if (/\.(exe|com)$/i.test(target)) return { file: target, args: [] };
  if (/\.(c|m)?js$/i.test(target) || !path.win32.extname(target)) {
    return { file: process.execPath, args: [target] };
  }
  return null;
}

// MSVCRT-style argument quoting followed by caret-escaping of cmd.exe
// metacharacters (the cross-spawn approach; doubled for .cmd/.bat shims).
export function escapeForCmd(arg, doubleEscape = true) {
  let a = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  a = `"${a}"`;
  a = a.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
  if (doubleEscape) a = a.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
  return a;
}

// cmd.exe cannot carry these through a command line at all.
export function cmdUnsafeReason(args) {
  for (const a of args) {
    if (/[\r\n\0]/.test(a)) return 'argument contains a newline/NUL';
    if (/%[^%\s"]*%/.test(a)) return 'argument contains %VAR% sequence';
  }
  return null;
}

// Decide how to launch argv on win32. Returns
//   { file, args, options }          to pass to child_process.spawn, or
//   { error }                        when it cannot be launched safely.
export async function planWindowsSpawn(argv, { env = process.env, stdinArg = null } = {}) {
  let args = argv.slice(1);
  let input = null;
  const resolved = (await which(argv[0], { platform: 'win32', env })) ?? argv[0];
  const isShim = /\.(cmd|bat)$/i.test(resolved);
  if (!isShim) return { file: resolved, args, input, options: {} };

  const shim = parseCmdShim(resolved);
  if (shim) return { file: shim.file, args: [...shim.args, ...args], input, options: {} };

  // Unrecognised .cmd/.bat: go through cmd.exe with careful quoting. Long or
  // multi-line prompts travel on stdin when the adapter supports it.
  if (stdinArg != null) {
    const k = args.indexOf(stdinArg);
    if (k !== -1) { args = [...args.slice(0, k), ...args.slice(k + 1)]; input = stdinArg; }
  }
  const bad = cmdUnsafeReason(args);
  if (bad) return { error: `cannot pass arguments through ${path.win32.basename(resolved)} safely (${bad}); install a native build of '${argv[0]}'` };
  const line = [escapeForCmd(resolved, false), ...args.map((a) => escapeForCmd(a))].join(' ');
  const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], input, options: { windowsVerbatimArguments: true } };
}
