import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { Pool } from './pool.mjs';
import { Journal } from './journal.mjs';
import { cacheKey, cacheRead, cacheWrite } from './cache.mjs';

const KNOWN_AGENT_OPTS = new Set(['label', 'model', 'schema', 'worktree', 'cwd', 'timeout', 'permission', 'via', 'reasoningEffort', 'retries', 'fetchImpl']);
const DEFAULT_GRACE_MS = 8000;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Determinism lint — mirror of Claude's inline-Workflow contract. A
// nondeterministic script body silently misaligns --resume's positional replay;
// --cache survives it but the journal trust does not. Reports real line numbers.
const NONDETERMINISTIC = /\b(?:Date\.now|Math\.random|new Date|crypto\.randomUUID)\b/g;
export function lintDeterminism(source) {
  // Blank out quoted strings so 'new Date' in a literal doesn't false-positive.
  // Template literals are kept: `${}` interpolations can hold real calls.
  const scanned = source.replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
  const hits = [];
  for (const m of scanned.matchAll(NONDETERMINISTIC)) {
    hits.push({ line: scanned.slice(0, m.index).split('\n').length, construct: m[0] });
  }
  return hits;
}

// Extract `export const meta = {...}` — the script's only supported export.
// The object is a plain literal (same constraint as Claude's workflow meta);
// it is removed from the evaluated source because `export` is illegal inside
// the async wrapper the script runs in.
function extractMeta(source, scriptName) {
  const m = /export\s+const\s+meta\s*=\s*/.exec(source);
  if (!m) return { meta: {}, source };
  const start = m.index + m[0].length;
  if (source[start] !== '{') {
    throw new SyntaxError(`${scriptName}: export const meta must be a plain object literal`);
  }
  let depth = 0, end = start, inStr = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) { end = i + 1; break; } }
  }
  if (depth !== 0) throw new SyntaxError(`${scriptName}: export const meta literal is unterminated`);
  const literal = source.slice(start, end);
  const meta = new Function(`return (${literal})`)();
  // Remove the whole statement (plus trailing semicolon/newline if present).
  let tail = end;
  while (tail < source.length && /[\s;]/.test(source[tail])) tail++;
  return { meta, source: source.slice(0, m.index) + source.slice(tail) };
}

export async function runScript(opts) {
  const {
    scriptPath,
    adapter,
    concurrency = 8,
    cwd = process.cwd(),
    args = [],
    resumeId = null,
    graceMs = DEFAULT_GRACE_MS,
    via = null,
    cache = false,
    maxAgents = 1000,
    retries = 0,
    err = (s) => process.stderr.write(s + '\n'),
    // Test seam: injected sleep removes wall-clock retry backoff from the
    // suite. Deliberately NOT used by the signal-drain loop below — a poll's
    // sleep IS its interval, and an instant injected sleep would spin the
    // event loop and starve the I/O that clears in-flight work.
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  const scriptName = basename(scriptPath);
  let source;
  try {
    source = readFileSync(scriptPath, 'utf8');
  } catch (e) {
    err(`agentflow: cannot read script ${scriptPath}: ${e.message}`);
    return { code: 1 };
  }

  let meta, body;
  try {
    ({ meta, source: body } = extractMeta(source, scriptName));
  } catch (e) {
    err(`agentflow: ${e.message}`);
    return { code: 1 };
  }

  if (opts.strict) {
    const hits = lintDeterminism(source);
    if (hits.length) {
      for (const h of hits) err(`agentflow: line ${h.line}: ${h.construct} is nondeterministic (--strict)`);
      err('agentflow: nondeterministic scripts silently misalign --resume replays; fix or drop --strict');
      return { code: 1 };
    }
  }

  // Resume: replay settled results by call index, re-execute the rest.
  const journalDir = Journal.dirFor(cwd);
  const runId = resumeId ?? opts.runId ?? Journal.newRunId();
  const journalPath = Journal.pathFor(cwd, runId);
  const prior = resumeId ? Journal.load(journalPath) : null;
  if (resumeId && !prior.runStart) {
    err(`agentflow: no journal for run '${resumeId}' under ${journalDir}`);
    return { code: 1 };
  }
  const journal = Journal.create(cwd, { runId, script: scriptName, harness: adapter.name, resumed: !!resumeId, pid: process.pid });

  const pool = new Pool(concurrency);
  const abort = new AbortController();
  const inFlight = new Set();
  let callIndex = 0;
  let phaseName = null;
  let interrupted = false;
  const t0 = Date.now();
  const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const logLine = (s) => err(`[${elapsed()}]${phaseName ? ` [${phaseName}]` : ''} ${s}`);

  async function agent(prompt, agentOpts = {}) {
    const i = callIndex++;
    if (i >= maxAgents) throw new Error(`agent-count cap exceeded (max ${maxAgents})`);
    const spec = { prompt: String(prompt), label: agentOpts.label ?? `agent-${i}` };
    for (const [k, v] of Object.entries(agentOpts)) {
      if (KNOWN_AGENT_OPTS.has(k)) spec[k] = v;
      else logLine(`warning: unknown agent() option '${k}' ignored`);
    }
    if (via && !spec.via) spec.via = via;

    if (prior?.settled.has(i)) {
      const rec = prior.settled.get(i);
      logLine(`replay ${spec.label} -> ${rec.ok ? 'ok' : 'null'}`);
      return rec.ok ? rec.result : null;
    }

    const cKey = cache ? cacheKey(adapter.name, { ...spec, cwd: spec.cwd ?? cwd }) : null;
    if (cKey) {
      const hit = cacheRead(cwd, cKey);
      if (hit !== undefined) {
        logLine(`${spec.label} -> cache`);
        return hit;
      }
    }

    const started = Date.now();
    // Journaling lives inside the task so inFlight.empty => durable record.
    // Returns {cancelled:true} when the call never genuinely ran: drained
    // queue, aborted spawn, or a failure caused by our own abort. Cancelled
    // calls are not journaled — resume must re-execute them.
    const settled = await pool.run(async () => {
      if (abort.signal.aborted) return { cancelled: true };
      inFlight.add(spec);
      try {
        // worktree:'auto' — runner-provisioned checkout, journaled. The
        // adapter never sees the literal (KTD3); 'true' still passes through
        // for adapter-native worktree flags. Provisioning failure settles
        // the call as an ordinary error and is never retried.
        let s = null;
        if (spec.worktree === 'auto') {
          try {
            const root = execFileSync('git', ['-C', spec.cwd ?? cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
            const wt = join(root, '.agentflow', 'worktrees', `${runId}-${i}`);
            execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', wt, 'HEAD']);
            spec.cwd = wt;
            delete spec.worktree;
            journal.append({ type: 'worktree', i, label: spec.label, path: wt, at: new Date().toISOString() });
          } catch (e) {
            const detail = String(e.stderr ?? e.message ?? e).trim().split('\n').pop();
            s = { ok: false, error: { message: `worktree: ${detail || 'not a git repo'}`, stderrTail: '', code: null, timedOut: false, permissionDenied: false } };
          }
        }
        // Bounded retry for transient failures (empty completions, flakes).
        // Never retried: permissionDenied (won't heal) and timedOut (rerun
        // just burns another timeout window). Backoff: 1000ms * attempt.
        const maxAttempts = 1 + Math.max(0, Math.floor(spec.retries ?? retries));
        for (let attempt = 1; s === null && attempt <= maxAttempts; attempt++) {
          s = await adapter.spawnAgent({ ...spec, signal: abort.signal, cwd: spec.cwd ?? cwd });
          if (s?.ok || abort.signal.aborted) break;
          const e = s?.error ?? {};
          if (e.permissionDenied || e.timedOut) break;
          if (attempt < maxAttempts) {
            logLine(`${spec.label} retry ${attempt}/${maxAttempts - 1} (${e.message ?? 'failed'})`);
            await sleep(1000 * attempt);
            s = null; // retry: clear the failed result, re-enter the loop
          }
        }
        if (abort.signal.aborted && !s?.ok) return { cancelled: true };
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        if (s.ok) {
          journal.append({ type: 'agent', i, label: spec.label, ok: true, result: s.result, model: spec.model ?? null, elapsed: secs, at: new Date().toISOString() });
          if (cKey) cacheWrite(cwd, cKey, s.result);
          return { ok: true, result: s.result, elapsed: secs };
        }
        journal.append({ type: 'agent', i, label: spec.label, ok: false, error: s.error, model: spec.model ?? null, elapsed: secs, at: new Date().toISOString() });
        return { ok: false, error: s.error, elapsed: secs };
      } catch (e) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const error = { message: String(e?.message ?? e), permissionDenied: false };
        journal.append({ type: 'agent', i, label: spec.label, ok: false, error, model: spec.model ?? null, elapsed: secs, at: new Date().toISOString() });
        return { ok: false, error, elapsed: secs };
      } finally {
        inFlight.delete(spec);
      }
    });

    if (settled == null || settled.__agentflowError || settled.cancelled) {
      const e = settled?.__agentflowError;
      logLine(`${spec.label} -> null (${e ? String(e.message ?? e).slice(0, 120) : 'cancelled'})`);
      return null;
    }

    if (settled.ok) {
      logLine(`${spec.label} -> ok (${settled.elapsed}s${spec.model ? `, ${spec.model}` : ''})`);
      return settled.result;
    }
    const kind = settled.error?.permissionDenied ? 'permission-denied' : settled.error?.timedOut ? 'timeout' : 'error';
    logLine(`${spec.label} -> null (${kind}: ${String(settled.error?.message ?? '').slice(0, 120)})`);
    return null;
  }

  const parallel = (thunks) => Promise.all([...thunks].map((t) => (typeof t === 'function' ? t() : t)));

  const pipeline = (items, ...stages) =>
    parallel(items.map((item) => async () => {
      let v = item;
      for (const s of stages) {
        v = await s(v);
        if (v == null) return null;
      }
      return v;
    }));

  const phase = (name) => { phaseName = name; logLine(`phase: ${name}`); };
  const log = (msg) => logLine(String(msg));

  let signalPromise = null;
  function onSignal(sig) {
    if (interrupted) return;
    interrupted = true;
    const exitCode = sig === 'SIGINT' ? 130 : 143;
    signalPromise = (async () => {
      logLine(`${sig} — draining ${pool.queue.length} queued, ${inFlight.size} in flight (grace ${graceMs}ms)`);
      pool.drain();
      const deadline = Date.now() + graceMs;
      while (inFlight.size && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (inFlight.size) {
        logLine(`aborting ${inFlight.size} in-flight agent(s)`);
        abort.abort();
        await new Promise((r) => setTimeout(r, 500));
      }
      journal.append({ type: 'run-end', reason: 'interrupted', at: new Date().toISOString() });
      logLine(`run ${runId} interrupted — resume with: agentflow run ${scriptName} --resume ${runId}`);
      process.exit(exitCode);
    })();
  }
  const sigint = () => void onSignal('SIGINT');
  const sigterm = () => void onSignal('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);

  let fn;
  try {
    fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'meta', body);
  } catch (e) {
    journal.append({ type: 'run-end', reason: 'error', at: new Date().toISOString() });
    err(`agentflow: syntax error in ${scriptName}: ${e.message}`);
    return { code: 1, runId, journalPath };
  }

  let code = 0;
  try {
    await fn(agent, parallel, pipeline, phase, log, args, meta);
    // If a signal is mid-handling, wait for it: in-flight results must be
    // journaled and the exit code must be the signal code, not success.
    if (signalPromise) process.exit(await signalPromise);
    journal.append({ type: 'run-end', reason: 'ok', at: new Date().toISOString() });
  } catch (e) {
    journal.append({ type: 'run-end', reason: 'error', error: String(e?.stack ?? e), at: new Date().toISOString() });
    err(`agentflow: ${scriptName} failed: ${e?.message ?? e}`);
    code = 1;
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
  return { code, runId, journalPath };
}
