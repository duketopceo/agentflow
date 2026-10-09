import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Pool } from './pool.mjs';
import { Journal } from './journal.mjs';

const KNOWN_AGENT_OPTS = new Set(['label', 'model', 'schema', 'worktree', 'cwd', 'timeout', 'permission', 'via']);
const DEFAULT_GRACE_MS = 8000;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

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
    err = (s) => process.stderr.write(s + '\n'),
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

  // Resume: replay settled results by call index, re-execute the rest.
  const journalDir = Journal.dirFor(cwd);
  const runId = resumeId ?? Journal.newRunId();
  const journalPath = Journal.pathFor(cwd, runId);
  const prior = resumeId ? Journal.load(journalPath) : null;
  if (resumeId && !prior.runStart) {
    err(`agentflow: no journal for run '${resumeId}' under ${journalDir}`);
    return { code: 1 };
  }
  const journal = Journal.create(cwd, { runId, script: scriptName, harness: adapter.name, resumed: !!resumeId });

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

    const started = Date.now();
    // Journaling lives inside the task so inFlight.empty => durable record.
    // Returns {cancelled:true} when the call never genuinely ran: drained
    // queue, aborted spawn, or a failure caused by our own abort. Cancelled
    // calls are not journaled — resume must re-execute them.
    const settled = await pool.run(async () => {
      if (abort.signal.aborted) return { cancelled: true };
      inFlight.add(spec);
      try {
        const s = await adapter.spawnAgent({ ...spec, signal: abort.signal, cwd: spec.cwd ?? cwd });
        if (abort.signal.aborted && !s?.ok) return { cancelled: true };
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        if (s.ok) {
          journal.append({ type: 'agent', i, label: spec.label, ok: true, result: s.result, model: spec.model ?? null, elapsed: secs, at: new Date().toISOString() });
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
