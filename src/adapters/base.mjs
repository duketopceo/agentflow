import { spawn } from 'node:child_process';
import { which } from './which.mjs';

const STDERR_TAIL = 8192;

// spawn a CLI, capture stdout/stderr, enforce timeout and abort.
// Never throws: failures return a structured result for the caller to classify.
export function spawnProcess(argv, { cwd, timeout, signal, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: cwd ?? process.cwd(),
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ spawnError: e.message });
    }
    let stdout = '', stderr = '', timedOut = false, done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const timer = timeout ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); }, timeout) : null;
    const onAbort = () => child.kill('SIGKILL');
    if (signal) {
      if (signal.aborted) { child.kill('SIGKILL'); }
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > STDERR_TAIL * 4) stderr = stderr.slice(-STDERR_TAIL * 4); });
    child.on('error', (e) => { clearTimeout(timer); finish({ spawnError: e.message, stderr }); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      finish({ code, sig, stdout, stderr: stderr.slice(-STDERR_TAIL), timedOut });
    });
  });
}

// Best-effort JSON extraction: whole body, then fenced json, then first balanced object.
export function extractJson(text) {
  if (!text) return null;
  const t = text.trim();
  try { return JSON.parse(t); } catch {}
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(t);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const start = t.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = null;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; }
    else if (c === '"') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// Prompt-level schema enforcement for adapters without a native flag.
export function withSchemaPrompt(spec) {
  if (!spec.schema) return spec;
  return {
    ...spec,
    prompt: `${spec.prompt}\n\nRespond with only a JSON object matching this schema, no prose:\n${JSON.stringify(spec.schema)}`,
  };
}

// permissionDeniedPatterns: adapter-supplied regexes matched against stderr+stdout
// when the process exits nonzero. Keeps headless approval-stalls distinct from
// ordinary agent failure.
export function classifyFailure(r, patterns = []) {
  const blob = `${r.stderr ?? ''}\n${r.stdout ?? ''}`;
  return {
    message: r.spawnError
      ? `spawn failed: ${r.spawnError}`
      : r.timedOut
        ? `timed out`
        : `exit ${r.code ?? r.sig ?? '?'}`,
    stderrTail: (r.stderr ?? '').slice(-STDERR_TAIL),
    code: r.code ?? null,
    timedOut: !!r.timedOut,
    permissionDenied: patterns.some((p) => p.test(blob)),
  };
}

// Generic spawnAgent given an adapter's buildArgv/parse/permissionDeniedPatterns.
export async function spawnAgent(adapter, spec) {
  const argv = adapter.buildArgv(spec);
  const r = await spawnProcess(argv, { cwd: spec.cwd, timeout: spec.timeout, signal: spec.signal, env: adapter.buildEnv?.(spec) });
  if (r.spawnError) return { ok: false, error: classifyFailure(r, adapter.permissionDeniedPatterns) };
  if (r.code === 0 && !r.timedOut) {
    const result = adapter.parse(r, spec);
    if (result) return { ok: true, result };
    return { ok: false, error: { message: 'schema: could not parse required JSON from output', stderrTail: r.stderr, code: 0, timedOut: false, permissionDenied: false } };
  }
  return { ok: false, error: classifyFailure(r, adapter.permissionDeniedPatterns) };
}

// Default probe: binary resolves, `--help` exits, and emitted flags appear in help text.
export async function probeBinary(adapter) {
  const path = await which(adapter.bin);
  if (!path) return { ok: false, name: adapter.name, bin: adapter.bin, notes: ['binary not on PATH'] };
  const help = await spawnProcess([adapter.bin, ...(adapter.helpArgs ?? ['--help'])], { timeout: 10000 });
  const blob = (help.stdout ?? '') + (help.stderr ?? '');
  const missing = (adapter.requiredFlags ?? []).filter((f) => !blob.includes(f));
  const notes = [];
  if (help.code !== 0 && help.code !== null && help.spawnError) notes.push(`--help failed: ${help.spawnError}`);
  if (missing.length) notes.push(`flags not found in --help: ${missing.join(', ')}`);
  return { ok: missing.length === 0, name: adapter.name, bin: adapter.bin, path, missingFlags: missing, notes };
}
