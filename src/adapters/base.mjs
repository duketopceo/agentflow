import { spawn } from 'node:child_process';
import { which } from './which.mjs';

const STDERR_TAIL = 8192;

// spawn a CLI, capture stdout/stderr, enforce timeout and abort.
// Never throws: failures return a structured result for the caller to classify.
export function spawnProcess(argv, { cwd, timeout, signal, env, onSpawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: cwd ?? process.cwd(),
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      child.on('spawn', () => {
        try { process.setpgid(child.pid, child.pid); } catch {}
        // The child is a process-group leader (detached + setpgid) so timeout
        // and abort can kill its whole tree — but that also means the group
        // survives if WE die. Reporting the pgid lets a later --resume reap
        // the stray before re-executing the same unit.
        if (typeof onSpawn === 'function' && child.pid != null) {
          try { onSpawn(child.pid, argv[0]); } catch {}
        }
      });
    } catch (e) {
      return resolve({ spawnError: e.message });
    }
    let stdout = '', stderr = '', timedOut = false, done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); } catch { child.kill(sig); }
    };
    const timer = timeout ? setTimeout(() => { timedOut = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 2000).unref(); }, timeout) : null;
    const onAbort = () => killGroup('SIGKILL');
    if (signal) {
      if (signal.aborted) { killGroup('SIGKILL'); }
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    // Decode via StringDecoder: raw Buffer chunks can split a multi-byte char.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
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
  // Try each '{' in turn: prose before the real object may contain stray
  // braces ("use {x} like so: {...}"). Bounded so brace-heavy junk stays cheap.
  // A balanced block that fails to parse is skipped whole so a nested
  // sub-object of a malformed outer object is never returned.
  let start = t.indexOf('{');
  for (let tries = 0; start !== -1 && tries < 64; tries++) {
    const end = balancedEnd(t, start);
    if (end !== -1) {
      try { return JSON.parse(t.slice(start, end + 1)); } catch {}
    }
    start = t.indexOf('{', end === -1 ? start + 1 : end + 1);
  }
  return null;
}

function balancedEnd(t, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// Minimal JSON-Schema validator for the subset agentflow actually uses.
// Returns null when valid, a short error string otherwise.
export function validateJson(schema, value, path = '') {
  if (schema == null) return null;

  if (Array.isArray(schema.type)) {
    if (!schema.type.some((t) => typeMatches(t, value))) return `${path || 'value'} is not one of [${schema.type.join(', ')}]`;
  } else if (schema.type && !typeMatches(schema.type, value)) {
    return `${path || 'value'} is not ${schema.type}`;
  }

  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    return `${path || 'value'} does not equal ${JSON.stringify(schema.const)}`;
  }
  if (schema.enum && !schema.enum.some((v) => deepEqual(v, value))) {
    return `${path || 'value'} is not one of ${JSON.stringify(schema.enum)}`;
  }

  if (value == null) return null;

  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) return `${path} shorter than ${schema.minLength}`;
    if (schema.maxLength != null && value.length > schema.maxLength) return `${path} longer than ${schema.maxLength}`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} does not match pattern ${schema.pattern}`;
  }

  if (typeof value === 'number' && !Number.isNaN(value)) {
    if (schema.minimum != null && value < schema.minimum) return `${path} below minimum ${schema.minimum}`;
    if (schema.maximum != null && value > schema.maximum) return `${path} above maximum ${schema.maximum}`;
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) return `${path} not above ${schema.exclusiveMinimum}`;
    if (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) return `${path} below ${schema.exclusiveMaximum}`;
    if (schema.multipleOf != null && value % schema.multipleOf !== 0) return `${path} not a multiple of ${schema.multipleOf}`;
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) return `${path} has fewer than ${schema.minItems} items`;
    if (schema.maxItems != null && value.length > schema.maxItems) return `${path} has more than ${schema.maxItems} items`;
    if (schema.uniqueItems && new Set(value.map(jsonKey)).size !== value.length) return `${path} has duplicate items`;
    if (schema.items) for (let i = 0; i < value.length; i++) {
      const err = validateJson(schema.items, value[i], `${path}[${i}]`);
      if (err) return err;
    }
    if (schema.prefixItems) for (let i = 0; i < Math.min(schema.prefixItems.length, value.length); i++) {
      const err = validateJson(schema.prefixItems[i], value[i], `${path}[${i}]`);
      if (err) return err;
    }
  }

  if (isPlainObject(value)) {
    const props = schema.properties ?? {};
    if (schema.required) for (const k of schema.required) {
      if (!(k in value)) return `${path || 'object'} is missing required property '${k}'`;
    }
    const additional = schema.additionalProperties;
    for (const [k, v] of Object.entries(value)) {
      if (k in props) {
        const err = validateJson(props[k], v, `${path}.${k}`);
        if (err) return err;
      } else if (additional === false) {
        return `${path || 'object'} has unexpected property '${k}'`;
      } else if (typeof additional === 'object' && additional != null) {
        const err = validateJson(additional, v, `${path}.${k}`);
        if (err) return err;
      }
    }
  }

  return null;
}

function typeMatches(t, v) {
  switch (t) {
    case 'object': return isPlainObject(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && !Number.isNaN(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return false;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

function jsonKey(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
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

// Harnesses `ori` can wrap (ori <name> injects OpenRouter env, rest passthrough).
// Verified against `ori --help`: claude, codex, opencode, grok, kilo, hermes,
// cline, pi, muse, omp, prime-agent. Not devin.
const ORI_WRAPPED = new Set(['claude', 'codex', 'opencode', 'grok', 'kilo', 'hermes', 'cline', 'pi', 'muse', 'omp', 'prime-agent']);

// `via: 'ori'` rewrites the harness argv into `ori <name>` form. Ori consumes
// --model and --reasoning-effort itself in wrapper mode and translates both to
// the harness's native mechanism — so the adapter's own model flag (modelFlag)
// is stripped and re-injected as ori's --model after the harness name.
// Pure for testability.
export function applyVia(adapter, argv, spec) {
  if (spec.via !== 'ori' || adapter.bin === 'ori') return { argv };
  if (!ORI_WRAPPED.has(adapter.bin)) return { error: `--via ori: no 'ori ${adapter.bin}' launcher` };
  const rest = argv.slice(1); // binary name becomes the ori subcommand
  const inject = [];
  if (spec.model && adapter.modelFlag) {
    const j = rest.indexOf(adapter.modelFlag);
    if (j !== -1) rest.splice(j, 2);
    inject.push('--model', spec.model);
  }
  if (spec.reasoningEffort) inject.push('--reasoning-effort', spec.reasoningEffort);
  return { argv: ['ori', adapter.bin, ...inject, ...rest] };
}

// Generic spawnAgent given an adapter's buildArgv/parse/permissionDeniedPatterns.
export async function spawnAgent(adapter, spec) {
  const wrapped = applyVia(adapter, adapter.buildArgv(spec), spec);
  if (wrapped.error) {
    return { ok: false, error: { message: wrapped.error, stderrTail: '', code: null, timedOut: false, permissionDenied: false } };
  }
  const argv = wrapped.argv;
  const r = await spawnProcess(argv, { cwd: spec.cwd, timeout: spec.timeout, signal: spec.signal, env: adapter.buildEnv?.(spec), onSpawn: spec.onSpawn });
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

// Normalize batch results into Map custom_id -> response body. Handles both
// the array-of-entries and keyed-object shapes providers return; adapters
// emit [{custom_id, result}] arrays from their own getBatch.
export function batchResultMap(results) {
  const byId = new Map();
  const put = (cid, v) => { if (cid != null) byId.set(cid, v?.result ?? v?.response ?? v); };
  if (Array.isArray(results)) for (const r of results) put(r?.custom_id, r);
  else if (results && typeof results === 'object') for (const [k, v] of Object.entries(results)) put(k, v);
  return byId;
}
