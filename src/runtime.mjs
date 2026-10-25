import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Pool } from './pool.mjs';
import { Journal } from './journal.mjs';
import { cacheKey, cacheRead, cacheWrite } from './cache.mjs';
import { validateJson } from './adapters/base.mjs';

const KNOWN_AGENT_OPTS = new Set(['label', 'model', 'schema', 'worktree', 'cwd', 'timeout', 'permission', 'via', 'reasoningEffort', 'retries', 'schemaRetries', 'fetchImpl']);
const DEFAULT_GRACE_MS = 8000;

// Replay fingerprint — sha over the spec fields that determine what a call
// returns. label/timeout/retries/fetchImpl are display or execution policy:
// changing them must NOT invalidate journaled results. On --resume a settled
// record replays only when its fp matches the call's (legacy records with no
// fp replay unconditionally, preserving pre-fp journals); a mismatch
// re-executes and overwrites, so a stale result can never surface.
export const fpOf = (harness, spec) => createHash('sha256').update(JSON.stringify({
  h: harness, p: spec.prompt, m: spec.model ?? null, s: spec.schema ?? null,
  w: spec.worktree ?? null, c: spec.cwd ?? null, pm: spec.permission ?? null,
  v: spec.via ?? null, re: spec.reasoningEffort ?? null,
})).digest('hex').slice(0, 16);
const replayable = (rec, fp) => rec != null && (rec.fp == null || rec.fp === fp);

// Reap stray harness groups a dead parent left running. A 'spawn' record whose
// call never settled is a mid-execution orphan: if the process group is still
// alive it keeps mutating the checkout while the resumed run re-issues the
// same unit. The journaled pid doubles as the group id (adapters spawn
// detached + setpgid). /proc is the only portable liveness+identity check we
// have: no /proc entry means the group is already gone; an argv[0] that does
// not name the recorded binary means pid reuse — leave it alone either way.
export function reapStrays(spawns, tell = () => {}) {
  for (const [i, rec] of spawns) {
    const pgid = rec?.pid;
    if (typeof pgid !== 'number' || pgid <= 1) continue;
    let argv0;
    try { argv0 = readFileSync(`/proc/${pgid}/cmdline`, 'utf8').split('\0')[0]; }
    catch { continue; }
    if (!argv0.includes(rec.bin ?? '')) {
      tell(`stray check [${i}] ${rec.label}: pgid ${pgid} alive but argv0 is '${argv0}' not '${rec.bin}' — left alone`);
      continue;
    }
    try { process.kill(-pgid, 'SIGKILL'); }
    catch {
      try { process.kill(pgid, 'SIGKILL'); }
      catch (e) { tell(`stray [${i}] ${rec.label}: kill failed: ${e.message}`); continue; }
    }
    tell(`reaped stray [${i}] ${rec.label} (pgid ${pgid} still running from a dead parent)`);
  }
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const RealDate = globalThis.Date;
const RealMath = globalThis.Math;
const RealCrypto = globalThis.crypto ?? {};

// Runtime determinism guard — shadow Date, Math and crypto in the script body.
// The script runs as an AsyncFunction in the host process, so this is advisory:
// a motivated script can still reach globalThis.Date etc. By default we throw on
// the common nondeterministic calls; --allow-nondeterminism passes the real ones.
function makeShimDate() {
  function Date(...args) {
    if (new.target === undefined) throw new Error('agentflow: direct Date() is nondeterministic; use --allow-nondeterminism to opt out');
    if (args.length === 0) throw new Error('agentflow: new Date() is nondeterministic; use --allow-nondeterminism to opt out');
    return new RealDate(...args);
  }
  Date.now = () => { throw new Error('agentflow: Date.now() is nondeterministic; use --allow-nondeterminism to opt out'); };
  Date.parse = RealDate.parse;
  Date.UTC = RealDate.UTC;
  Date.prototype = RealDate.prototype;
  return Date;
}

const shimMath = new Proxy(RealMath, {
  get(t, p) {
    if (p === 'random') return () => { throw new Error('agentflow: Math.random() is nondeterministic; use --allow-nondeterminism to opt out'); };
    return t[p];
  },
});

const shimCrypto = new Proxy(RealCrypto, {
  get(t, p) {
    if (p === 'randomUUID' || p === 'getRandomValues') return () => { throw new Error(`agentflow: crypto.${String(p)}() is nondeterministic; use --allow-nondeterminism to opt out`); };
    return t[p];
  },
});

function makeDeterminismShims(allow) {
  if (allow) return { Date: RealDate, Math: RealMath, crypto: RealCrypto };
  return { Date: makeShimDate(), Math: shimMath, crypto: shimCrypto };
}

// Extract `export const meta = {...}` — the script's only supported export.
// The object is a plain literal (same constraint as Claude's workflow meta);
// it is removed from the evaluated source because `export` is illegal inside
// the async wrapper the script runs in.
function extractMeta(source, scriptName, shims) {
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
  // Evaluate the meta literal with the same determinism shims the script body
  // will run under, so a nondeterministic `Date.now()` in meta cannot slip past.
  const meta = new Function('Date', 'Math', 'crypto', `return (${literal})`)(shims.Date, shims.Math, shims.crypto);
  // Remove the whole statement (plus trailing semicolon/newline if present).
  let tail = end;
  while (tail < source.length && /[\s;]/.test(source[tail])) tail++;
  return { meta, source: source.slice(0, m.index) + source.slice(tail) };
}

const execFileP = promisify(execFile);
const GIT_TIMEOUT = { timeout: 60_000, killSignal: 'SIGKILL' };

// Provision `<root>/.agentflow/worktrees/<name>` as a detached HEAD checkout.
// Async — a synchronous spawn inside the pool task would stall every
// in-flight call's I/O (and the signal drain) for the full checkout. A dir
// left by a prior attempt of the same run (resume replays unsettled calls)
// is reused when it's still a valid worktree; anything else is reclaimed and
// re-provisioned. `roots` memoizes rev-parse per call cwd.
async function provisionWorktree(base, name, roots) {
  let root = roots.get(base);
  if (root === undefined) {
    root = (await execFileP('git', ['-C', base, 'rev-parse', '--show-toplevel'], { ...GIT_TIMEOUT, encoding: 'utf8' })).stdout.trim();
    roots.set(base, root);
  }
  const wt = join(root, '.agentflow', 'worktrees', name);
  const add = () => execFileP('git', ['-C', root, 'worktree', 'add', '--detach', wt, 'HEAD'], GIT_TIMEOUT);
  if (existsSync(wt)) {
    // A real worktree has a `.git` pointer file — a plain dir inside the repo
    // would pass `rev-parse` (walks up to the parent repo), so check the file.
    if (existsSync(join(wt, '.git'))) return { wt, root, reused: true };
    try { await execFileP('git', ['-C', root, 'worktree', 'remove', '--force', wt], GIT_TIMEOUT); } catch {}
    rmSync(wt, { recursive: true, force: true });
  }
  try { await add(); }
  catch {
    // dir is gone but git still holds a stale registration (interrupted rm)
    await execFileP('git', ['-C', root, 'worktree', 'prune'], GIT_TIMEOUT);
    await add();
  }
  return { wt, root, reused: false };
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
    schemaRetries = 4,
    batchPollMs = 15_000,
    batchTimeoutMs = 2 * 3600_000,
    fetchImpl = undefined,
    sleep: sleepImpl = undefined,
    allowNondeterminism = false,
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

  const shims = makeDeterminismShims(allowNondeterminism);
  const { Date: shimDate, Math: shimMath, crypto: shimCrypto } = shims;

  let meta, body;
  try {
    ({ meta, source: body } = extractMeta(source, scriptName, shims));
  } catch (e) {
    err(`agentflow: ${e.message}`);
    return { code: 1 };
  }

  // Resume: replay settled results by call index, re-execute the rest.
  const journalDir = Journal.dirFor(cwd);
  const runId = resumeId ?? opts.runId ?? Journal.newRunId();
  let journalPath;
  try { journalPath = Journal.pathFor(cwd, runId); }
  catch (e) { err(`agentflow: ${e.message}`); return { code: 1 }; }
  const prior = resumeId ? Journal.load(journalPath) : null;
  if (resumeId && !prior.runStart) {
    err(`agentflow: no journal for run '${resumeId}' under ${journalDir}`);
    return { code: 1 };
  }
  // Harness is a fingerprint input — a run resumed under a different harness
  // re-executes every call. Say so once, up front, instead of N replay misses.
  if (prior?.runStart?.harness && prior.runStart.harness !== adapter.name) {
    err(`agentflow: journal is a '${prior.runStart.harness}' run — all calls re-execute under '${adapter.name}'`);
  }
  // run-start carries the workflow's display identity (name, declared phases)
  // so watch/status can title and group the run without re-parsing the script.
  const journal = Journal.create(cwd, {
    runId, script: scriptName, harness: adapter.name, resumed: !!resumeId, pid: process.pid, graceMs,
    name: typeof meta.name === 'string' ? meta.name : undefined,
    phases: Array.isArray(meta.phases) ? meta.phases.filter((p) => typeof p === 'string') : undefined,
  });

  const pool = new Pool(concurrency);
  const abort = new AbortController();
  // Test seam + abort-aware sleep: tests inject an instant sleep; the default
  // resolves early when the run aborts (SIGINT drain). Deliberately NOT used
  // by the signal-drain loop below — a poll's sleep IS its interval, and an
  // instant injected sleep would spin the event loop and starve the I/O that
  // clears in-flight work.
  const sleep = sleepImpl ?? ((ms) => new Promise((r) => {
    const t = setTimeout(r, ms);
    abort.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  }));
  const inFlight = new Set();
  const wtRoots = new Map(); // per-call-cwd -> git toplevel cache for worktree:'auto'
  let callIndex = 0;
  let phaseName = null;
  let interrupted = false;
  const t0 = Date.now();
  const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const logLine = (s) => err(`[${elapsed()}]${phaseName ? ` [${phaseName}]` : ''} ${s}`);

  // A prior epoch that died mid-call may have left its harness process group
  // alive — adapters spawn detached + setpgid precisely so timeout/abort can
  // kill the tree, which also detaches it from parent-death reaping. Journaled
  // spawn records name the group; kill it before re-executing the same unit
  // or two agents end up mutating the same checkout.
  if (resumeId && prior.spawns.size) reapStrays(prior.spawns, logLine);

  async function agent(prompt, agentOpts = {}) {
    const i = callIndex++;
    if (i >= maxAgents) throw new Error(`agent-count cap exceeded (max ${maxAgents})`);
    const spec = { prompt: String(prompt), label: agentOpts.label ?? `agent-${i}` };
    for (const [k, v] of Object.entries(agentOpts)) {
      if (KNOWN_AGENT_OPTS.has(k)) spec[k] = v;
      else logLine(`warning: unknown agent() option '${k}' ignored`);
    }
    if (via && !spec.via) spec.via = via;
    const fp = fpOf(adapter.name, spec);

    const rec = prior?.settled.get(i);
    if (replayable(rec, fp)) {
      logLine(`replay ${spec.label} -> ${rec.ok ? 'ok' : 'null'}`);
      return rec.ok ? rec.result : null;
    }
    if (rec != null) logLine(`replay miss [${i}] ${spec.label} — call changed since run, re-executing`);

    const cKey = cache ? cacheKey(adapter.name, { ...spec, cwd: spec.cwd ?? cwd }) : null;
    if (cKey) {
      const hit = cacheRead(cwd, cKey);
      if (hit !== undefined) {
        logLine(`${spec.label} -> cache`);
        return hit;
      }
    }

    const started = Date.now();
    // Report each spawned harness child so a dead parent can't leave a live
    // process group mutating the checkout unseen (reaped on --resume).
    spec.onSpawn = (pid, bin) =>
      journal.append({ type: 'spawn', i, label: spec.label, pid, bin, at: new Date().toISOString() });
    // Journaling lives inside the task so inFlight.empty => durable record.
    // Returns {cancelled:true} when the call never genuinely ran: drained
    // queue, aborted spawn, or a failure caused by our own abort. Cancelled
    // calls are not journaled — resume must re-execute them.
    const settled = await pool.run(async () => {
      if (abort.signal.aborted) return { cancelled: true };
      inFlight.add(spec);
      journal.append({ type: 'in-flight', i, label: spec.label, model: spec.model ?? null, at: new Date().toISOString() });
      try {
        // worktree:'auto' — runner-provisioned checkout, journaled. The
        // adapter never sees the literal (KTD3); 'true' still passes through
        // for adapter-native worktree flags. Provisioning failure settles
        // the call as an ordinary error and is never retried.
        let s = null;
        if (spec.worktree === 'auto') {
          try {
            const { wt, root, reused } = await provisionWorktree(spec.cwd ?? cwd, `${runId}-${i}`, wtRoots);
            spec.cwd = wt;
            delete spec.worktree;
            if (!reused) journal.append({ type: 'worktree', i, label: spec.label, path: wt, root, at: new Date().toISOString() });
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

        // Schema validation + repair retry. A schema result must parse and pass
        // the subset validator; if not, re-prompt with the error up to
        // schemaRetries additional attempts.
        if (s?.ok && spec.schema) {
          const maxSchemaAttempts = 1 + Math.max(0, Math.floor(spec.schemaRetries ?? schemaRetries));
          for (let attempt = 1; s?.ok && attempt <= maxSchemaAttempts; attempt++) {
            const why = s.result.json == null
              ? 'could not parse required JSON'
              : validateJson(spec.schema, s.result.json);
            if (why == null) break;
            if (attempt === maxSchemaAttempts) {
              s = { ok: false, error: { message: `schema: ${why}`, stderrTail: String(s.result.text ?? '').slice(-500), code: 0, timedOut: false, permissionDenied: false } };
              break;
            }
            logLine(`${spec.label} schema retry ${attempt}/${maxSchemaAttempts - 1} (${why.slice(0, 120)})`);
            const repair = `${spec.prompt}\n\nYour previous response did not match the required JSON schema: ${why}\nRaw response was: ${String(s.result.text ?? '').slice(0, 1000)}\nRespond with only a JSON object matching the schema, no prose.`;
            s = await adapter.spawnAgent({ ...spec, prompt: repair, signal: abort.signal, cwd: spec.cwd ?? cwd });
          }
        }

        if (abort.signal.aborted && !s?.ok) return { cancelled: true };
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        if (s.ok) {
          journal.append({ type: 'agent', i, label: spec.label, ok: true, result: s.result, model: spec.model ?? null, fp, elapsed: secs, at: new Date().toISOString() });
          if (cKey) cacheWrite(cwd, cKey, s.result);
          return { ok: true, result: s.result, elapsed: secs };
        }
        journal.append({ type: 'agent', i, label: spec.label, ok: false, error: s.error, model: spec.model ?? null, fp, elapsed: secs, at: new Date().toISOString() });
        return { ok: false, error: s.error, elapsed: secs };
      } catch (e) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const error = { message: String(e?.message ?? e), permissionDenied: false };
        journal.append({ type: 'agent', i, label: spec.label, ok: false, error, model: spec.model ?? null, fp, elapsed: secs, at: new Date().toISOString() });
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

  // batch(items, opts): one async OR Batch job per call — submit once, poll,
  // resolve an array aligned to input order (failed items settle null).
  // Every item consumes a normal call index, so positional --resume replay is
  // unchanged; a mid-poll interrupt leaves the journaled batch record pending
  // and resume re-polls that batch_id instead of resubmitting (R3).
  async function batch(items, batchOpts = {}) {
    if (!adapter.supportsBatch) {
      throw new Error(`batch() requires a batch-capable harness (--harness openrouter); got '${adapter.name}'`);
    }
    const list = [...(items ?? [])];
    if (!list.length) return [];
    const firstI = callIndex;
    const specs = list.map((it) => {
      const i = callIndex++;
      if (i >= maxAgents) throw new Error(`agent-count cap exceeded (max ${maxAgents})`);
      const spec = { prompt: String(it?.prompt ?? it), label: it?.label ?? `batch-${i}` };
      for (const [k, v] of Object.entries(typeof it === 'object' && it !== null ? it : {})) {
        if (k === 'prompt') continue;
        if (KNOWN_AGENT_OPTS.has(k)) spec[k] = v;
        else logLine(`warning: unknown batch() option '${k}' ignored`);
      }
      return { spec, i };
    });
    const model = batchOpts.model ?? specs[0].spec.model;
    const seen = [...new Set(specs.map(({ spec }) => spec.model ?? model))];
    if (seen.length !== 1) {
      throw new Error(`batch() is single-model per call (OR batches carry one model) — got: ${seen.join(', ')}`);
    }
    for (const { spec } of specs) spec.model = model;
    for (const s of specs) s.fp = fpOf(adapter.name, s.spec); // fp after model normalization — model is an fp input

    const isSettled = ({ i, fp }) => replayable(prior?.settled.get(i), fp);
    const fresh = specs.filter((s) => !isSettled(s));

    // Full replay: every item settled with a matching fingerprint — zero requests.
    if (prior && !fresh.length) {
      logLine(`replay batch[${firstI}..${firstI + specs.length - 1}]`);
      return specs.map(({ i }) => { const rec = prior.settled.get(i); return rec.ok ? rec.result : null; });
    }

    const label = `batch[${specs.length}]`;
    // Partial divergence resubmits only changed/new items — batch exists to
    // save spend; re-billing unchanged items on resume would defeat it.
    const bodies = fresh.map(({ spec }) => adapter.batchBody(spec));
    // batchBody carries buildBody's default model when none was given.
    const batchModel = model ?? bodies[0].model;
    const hash = createHash('sha256').update(JSON.stringify({ model: batchModel, bodies })).digest('hex').slice(0, 16);
    const io = { signal: abort.signal, fetchImpl: batchOpts.fetchImpl ?? fetchImpl };
    const started = Date.now();
    const secs = () => ((Date.now() - started) / 1000).toFixed(1);
    const freshIdx = fresh.map(({ i }) => i);
    const freshPos = new Map(fresh.map(({ i }, j) => [i, j]));
    const freshContiguous = freshIdx.every((v, j) => v === freshIdx[0] + j);
    // Journals one agent record per FRESH item at its own index; an item whose
    // settled record's fp still matches replays and is never re-journaled.
    // Cancelled tasks journal nothing — the pending batch record is what
    // resume re-polls.
    const settleAll = (perItem) => {
      const elapsed = secs();
      return specs.map(({ spec, i, fp }) => {
        const rec = prior?.settled.get(i);
        if (replayable(rec, fp)) return rec.ok ? { ok: true, result: rec.result } : { ok: false, error: rec.error };
        const s = perItem(spec, i, freshPos.get(i));
        journal.append({
          type: 'agent', i, label: spec.label, ok: s.ok,
          ...(s.ok ? { result: s.result } : { error: s.error }),
          model: spec.model ?? null, fp, elapsed, at: new Date().toISOString(),
        });
        return s;
      });
    };
    const settled = await pool.run(async () => {
      if (abort.signal.aborted) return { cancelled: true };
      inFlight.add(label);
      try {
        // A journaled batch re-polls when it covers exactly the fresh items.
        // New records carry `items` (possibly non-contiguous); legacy records
        // only had firstI+count, which always meant a contiguous range.
        const covers = (b) => (Array.isArray(b.items)
          ? b.items.length === freshIdx.length && b.items.every((v, j) => v === freshIdx[j])
          : freshContiguous && b.firstI === freshIdx[0] && b.count === freshIdx.length);
        const priorBatch = prior?.batches?.find(covers);
        let batchId = null;
        if (priorBatch?.hash === hash) {
          batchId = priorBatch.batch_id;
          logLine(`${label} re-polling journaled batch ${batchId}`);
        } else {
          if (priorBatch) logLine(`${label} spec changed since ${priorBatch.batch_id} — submitting fresh`);
          else if (fresh.length !== specs.length) logLine(`${label} ${specs.length - fresh.length} unchanged (replayed), ${fresh.length} to submit`);
          const sub = await adapter.submitBatch(batchModel, bodies, io);
          // Aborted mid-submit: the POST may or may not have landed on OR's
          // side, but no batch_id was journaled — leave indices unsettled so
          // resume re-runs batch() instead of replaying phantom errors.
          if (!sub.ok) {
            if (abort.signal.aborted) return { cancelled: true };
            return { items: settleAll(() => ({ ok: false, error: sub.error })) };
          }
          batchId = sub.batchId;
          journal.append({ type: 'batch', batch_id: batchId, firstI: freshIdx[0], count: fresh.length, items: freshIdx, model: batchModel, hash, at: new Date().toISOString() });
        }
        // Every FRESH item index is now pending on the batch — watch/status
        // show them in-flight until their own agent records land. Replayed
        // items are already settled and stay untouched.
        for (const { spec, i } of fresh) {
          journal.append({ type: 'in-flight', i, label: spec.label, model: spec.model ?? batchModel, batch: batchId, at: new Date().toISOString() });
        }
        const timeoutMs = batchOpts.batchTimeoutMs ?? batchTimeoutMs;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (abort.signal.aborted) return { cancelled: true };
          const b = await adapter.getBatch(batchId, io);
          journal.append({
            type: 'batch-poll', batch_id: batchId,
            status: b.ok ? (b.status ?? 'unknown') : `poll-error:${b.error?.code ?? b.error?.message ?? 'fetch'}`,
            ...(b.counts ? { pending: b.counts.pending, settled: b.counts.settled, total: b.counts.total } : {}),
            at: new Date().toISOString(),
          });
          if (!b.ok) {
            if (b.error?.permissionDenied) {
              return { items: settleAll(() => ({ ok: false, error: b.error })) };
            }
            // Transient poll failure — keep polling until the deadline.
          } else if (b.status === 'completed') {
            const byId = adapter.batchResultMap(b.results);
            return { items: settleAll((spec, i, k) => adapter.batchItemResult(byId.get(`c${k}`), spec)) };
          } else if (b.status === 'failed' || b.status === 'expired' || b.status === 'cancelled') {
            const error = { message: `${adapter.name}: batch ${b.status}${b.error?.message ? ` — ${b.error.message}` : ''}`, permissionDenied: false, timedOut: false };
            return { items: settleAll(() => ({ ok: false, error })) };
          }
          if (Date.now() > deadline) {
            const error = { message: `${adapter.name}: batch ${batchId} did not complete within ${timeoutMs}ms`, permissionDenied: false, timedOut: true };
            return { items: settleAll(() => ({ ok: false, error })) };
          }
          await sleep(batchOpts.batchPollMs ?? batchPollMs);
        }
      } catch (e) {
        if (abort.signal.aborted) return { cancelled: true };
        const error = { message: String(e?.message ?? e), permissionDenied: false };
        return { items: settleAll(() => ({ ok: false, error })) };
      } finally {
        inFlight.delete(label);
      }
    });

    if (settled == null || settled.__agentflowError || settled.cancelled) {
      const e = settled?.__agentflowError;
      logLine(`${label} -> null (${e ? String(e.message ?? e).slice(0, 120) : 'cancelled'})`);
      return null;
    }
    const nOk = settled.items.filter((s) => s.ok).length;
    logLine(`${label} -> ${nOk}/${specs.length} ok (${secs()}s)`);
    return settled.items.map((s) => (s.ok ? s.result : null));
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

  // A phase is display metadata: the journal record groups lanes for
  // watch/tail, replay never reads it. nextI marks the call index where the
  // phase begins so groups can be ordered against un-phased lanes.
  const phase = (name) => {
    phaseName = name;
    journal.append({ type: 'phase', name: String(name), nextI: callIndex, at: new Date().toISOString() });
    logLine(`phase: ${name}`);
  };
  const log = (msg) => logLine(String(msg));

  let signalPromise = null;
  let forced = false;
  let firstExitCode = 130;
  // Scripts may call process.exit (Claude-parity scripts do); it must never
  // take the runner down. During script evaluation it's replaced with a
  // sentinel throw caught at the fn() boundary — the runtime's own exits
  // (this signal path and the post-await signal join) hold realExit and
  // bypass the shim.
  const realExit = process.exit;
  function onSignal(sig) {
    if (interrupted) {
      // Second signal: the operator is done waiting out the grace window.
      if (forced) return;
      forced = true;
      logLine(`${sig} again — aborting ${inFlight.size} in-flight agent(s) now`);
      pool.drain();
      abort.abort();
      journal.append({ type: 'run-end', reason: 'interrupted', at: new Date().toISOString() });
      logLine(`run ${runId} interrupted — resume with: agentflow run ${scriptName} --resume ${runId}`);
      realExit(firstExitCode);
    }
    interrupted = true;
    const exitCode = sig === 'SIGINT' ? 130 : 143;
    firstExitCode = exitCode;
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
      realExit(exitCode);
    })();
  }
  const SCRIPT_EXIT = Symbol('script-exit');
  const sigint = () => void onSignal('SIGINT');
  const sigterm = () => void onSignal('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);

  let fn;
  try {
    // Wrap the body in a nested block so scripts can still declare their own
    // `Date`, `Math`, or `crypto` variables while the shims shadow the globals.
    const wrapped = `{
  const cwd = __agentflowCwd;
  const Date = __agentflowDate;
  const Math = __agentflowMath;
  const crypto = __agentflowCrypto;
  {
${body}
  }
}`;
    fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'batch', 'args', 'meta', '__agentflowDate', '__agentflowMath', '__agentflowCrypto', '__agentflowCwd', wrapped);
  } catch (e) {
    journal.append({ type: 'run-end', reason: 'error', at: new Date().toISOString() });
    err(`agentflow: syntax error in ${scriptName}: ${e.message}`);
    return { code: 1, runId, journalPath };
  }

  // JSON-round-trip a script's return value for the run-end record; anything
  // non-serializable degrades to a repr instead of failing the journal write.
  const jsonSafe = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch { return { unserializable: true, repr: String(v).slice(0, 500) }; } };

  let code = 0;
  let ret;
  process.exit = (c = 0) => { throw { [SCRIPT_EXIT]: c }; };
  try {
    ret = await fn(agent, parallel, pipeline, phase, log, batch, args, meta, shimDate, shimMath, shimCrypto, cwd);
    // If a signal is mid-handling, wait for it: in-flight results must be
    // journaled and the exit code must be the signal code, not success.
    if (signalPromise) realExit(await signalPromise);
    journal.append({ type: 'run-end', reason: 'ok', ...(ret !== undefined ? { result: jsonSafe(ret) } : {}), at: new Date().toISOString() });
  } catch (e) {
    const exitReq = e?.[SCRIPT_EXIT];
    if (exitReq !== undefined) {
      // process.exit(c) inside a script ends the script with code c.
      code = Number.isInteger(exitReq) ? exitReq : 1;
      journal.append({ type: 'run-end', reason: code === 0 ? 'ok' : 'error', at: new Date().toISOString() });
      if (code !== 0) err(`agentflow: ${scriptName} exited ${code} (process.exit)`);
    } else {
      journal.append({ type: 'run-end', reason: 'error', error: String(e?.stack ?? e), at: new Date().toISOString() });
      err(`agentflow: ${scriptName} failed: ${e?.message ?? e}`);
      code = 1;
    }
  } finally {
    process.exit = realExit;
    // Agent calls the script never awaited (or abandoned by a throw) must not
    // outlive the run: kill their processes and stop queued ones from starting.
    if (!interrupted && (inFlight.size || pool.queue.length)) {
      logLine(`aborting ${inFlight.size} unawaited agent call(s) left running at script end`);
      pool.drain();
      abort.abort();
    }
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
  return { code, runId, journalPath, result: ret };
}
