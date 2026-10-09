// Workflow script runtime (R1, R2, R4, R5): wraps an .mjs workflow in an async
// function with injected globals, executes it under the pool, journals every
// settled agent() call, and replays them on --resume.
//
// Trust boundary (KTD7): the script runs with the operator's full ambient
// privileges — AsyncFunction is an execution convenience, not isolation.
// Never run a script you haven't read, including agent-generated ones.

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Journal, SPEC_KEYS, runsDir, specHash } from "./journal.mjs";
import { Pool } from "./pool.mjs";
import { createWorktree, pruneWorktrees, removeWorktree } from "./worktree.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const KNOWN_OPTS = new Set(SPEC_KEYS.filter((k) => k !== "prompt"));

// Statically extract `export const meta = {...}` — export is illegal inside the
// wrapped body, so the literal is lifted out and stripped before eval (KTD2).
export function extractMeta(source) {
  const m = /export\s+const\s+meta\s*=\s*/.exec(source);
  if (!m) return { meta: null, source };
  const start = m.index + m[0].length;
  // Non-literal meta (e.g. `export const meta = f()`): drop just `export` so
  // the const still declares in script scope — leaving `export` in would make
  // the wrapped body a SyntaxError.
  const stripExport = source.slice(0, m.index) + source.slice(m.index + 6);
  if (source[start] !== "{") return { meta: null, source: stripExport };
  let depth = 0;
  let inStr = false;
  let quote = "";
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = true; quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end === -1) return { meta: null, source: stripExport };
  const literal = source.slice(start, end);
  let meta = null;
  try {
    meta = Function(`"use strict"; return (${literal})`)();
  } catch { /* unparseable meta — non-fatal */ }
  // Strip through the trailing semicolon if present.
  let tail = end;
  while (tail < source.length && /\s/.test(source[tail])) tail++;
  if (source[tail] === ";") tail++;
  return { meta, source: source.slice(0, m.index) + source.slice(tail) };
}

export class WorkflowRuntime {
  constructor({ dir, adapter, concurrency = 8, permission = "default", resumeId, runId, live = false } = {}) {
    this.dir = resolve(dir ?? process.cwd());
    this.adapter = adapter;
    this.ceiling = permission;
    this.live = live;
    this.runId = resumeId ?? runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    // runId names journal and worktree paths — reject traversal.
    if (!/^[\w.-]+$/.test(this.runId) || this.runId.includes("..")) {
      throw new Error(`invalid run id '${this.runId}' (allowed: letters, digits, '.', '_', '-')`);
    }
    this.pool = new Pool(concurrency);
    this.journal = new Journal(join(runsDir(this.dir), `${this.runId}.jsonl`));
    // Replay only on explicit --resume: a run-id collision without it must
    // re-execute, and a resume id with no journal must say so.
    this.replaying = Boolean(resumeId);
    if (this.replaying && this.journal.settled.size === 0) {
      this.log(`warn: --resume '${this.runId}' names no recorded run — starting fresh`);
    } else if (!this.replaying && this.journal.settled.size > 0) {
      this.log(`warn: run id '${this.runId}' already has a journal — calls will re-execute (pass --resume to replay)`);
    }
    this.seq = 0;
    pruneWorktrees(this.dir);
  }

  log(msg) {
    process.stderr.write(`[agentflow] ${msg}\n`);
  }

  phase(name) {
    this.log(`== phase: ${name}`);
  }

  // agent(prompt, opts) → { text, json? } | null  (R2)
  // Never throws — every pre-pool and journal failure maps to null so scripts
  // can rely on results.filter(Boolean) (KTD2 contract).
  async agent(prompt, opts = {}) {
    opts = opts && typeof opts === "object" ? opts : {};
    for (const k of Object.keys(opts)) {
      if (!KNOWN_OPTS.has(k)) this.log(`warn: unknown agent() option '${k}' ignored`);
    }
    const seq = this.seq++;
    let spec, hash;
    try {
      spec = this.#buildSpec(prompt, opts);
      if (spec.permission === "escalated" && this.ceiling !== "escalated") {
        this.log(`warn: agent() requested escalated permission; clamped to run ceiling '${this.ceiling}'`);
        spec.permission = "default";
      }
      hash = specHash(spec);
      const prior = this.replaying ? this.journal.lookup(seq, hash) : { hit: false };
      if (prior.hit) {
        this.log(`replay [${seq}] ${spec.label ?? ""} (settled)`);
        return prior.entry.result ?? null;
      }
      if (prior.failed) this.log(`retry [${seq}] ${spec.label ?? ""} (prior call failed)`);
      if (prior.mismatch) this.log(`warn: journal seq ${seq} spec changed since interrupt — re-executing`);
    } catch (e) {
      this.log(`warn: agent() [${seq}] failed before dispatch: ${e.message}`);
      return null;
    }

    const started = Date.now();
    const { started: spawned, result } = await this.pool.run(async () => {
      let managedWt = null;
      try {
        // Provision inside the admitted task: replay hits and closed-pool
        // calls never create worktrees, and every exit path cleans up.
        if (spec.worktree === true) {
          managedWt = createWorktree(this.dir, this.runId, seq);
          if (managedWt) spec.cwd = managedWt;
          else this.log("warn: worktree requested but cwd is not a git repo — falling back to cwd");
        } else if (typeof spec.worktree === "string") {
          spec.cwd = spec.worktree; // caller-managed path, never auto-removed
        }
        const raw = await this.adapter.spawnAgent(spec);
        if (!raw || raw.exitCode !== 0) {
          return { ok: false, result: null, stderrTail: raw?.stderrTail ?? "" };
        }
        return { ok: true, result: { text: raw.text, json: raw.json }, stderrTail: raw.stderrTail };
      } finally {
        if (managedWt) removeWorktree(this.dir, managedWt);
      }
    });

    if (!spawned) return null; // closed before start — unsettled, resumable

    const elapsed = Date.now() - started;
    const ok = result?.ok === true;
    const value = ok ? result.result : null;
    this.log(`settle [${seq}] ${spec.label ?? spec.prompt.slice(0, 40)} ${ok ? "ok" : "null"} ${elapsed}ms${spec.model ? ` ${spec.model}` : ""}`);
    try {
      this.journal.append({ seq, specHash: hash, label: spec.label ?? null, ok, result: value, stderrTail: result?.stderrTail ?? "", elapsedMs: elapsed, ts: new Date().toISOString() });
    } catch (e) {
      this.log(`warn: journal append failed for seq ${seq}: ${e.message}`);
    }
    return value;
  }

  #buildSpec(prompt, opts) {
    const timeout = opts.timeout ?? 300_000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      this.log(`warn: invalid agent() timeout '${opts.timeout}' — using 300000ms`);
    }
    const spec = {
      prompt: String(prompt),
      label: opts.label,
      model: opts.model,
      schema: opts.schema,
      cwd: opts.cwd ? resolve(this.dir, opts.cwd) : this.dir,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 300_000,
      permission: opts.permission ?? "default",
      sandbox: Boolean(opts.sandbox),
    };
    if (opts.worktree) {
      // Keep the option value for hashing — the provisioned path only exists
      // after pool admission and must not enter the replay key.
      spec.worktree = opts.worktree === true ? true : resolve(this.dir, opts.worktree);
    }
    return spec;
  }

  close() {
    this.pool.close();
  }
}

export async function runScript(scriptPath, opts) {
  const abs = isAbsolute(scriptPath) ? scriptPath : resolve(opts.dir ?? process.cwd(), scriptPath);
  let raw;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (e) {
    throw new Error(e.code === "ENOENT" ? `script not found: ${abs}` : `cannot read script ${abs}: ${e.message}`);
  }
  const { meta, source } = extractMeta(raw);

  const rt = new WorkflowRuntime(opts);
  rt.log(`run ${rt.runId} — ${meta?.name ?? scriptPath} via ${rt.adapter.name}`);

  const agentGlobals = {
    agent: (p, o) => rt.agent(p, o),
    parallel: (tasks) => Promise.all(tasks.map((t) => (typeof t === "function" ? t() : t))),
    pipeline: async (items, fn) => {
      const out = [];
      for (const item of items) out.push(await fn(item));
      return out;
    },
    phase: (n) => rt.phase(n),
    log: (m) => rt.log(m),
    args: opts.scriptArgs ?? [],
    live: rt.live,
    meta,
  };

  let interrupted = false;
  const onSignal = () => {
    if (interrupted) {
      rt.log("force quit — exiting without drain (in-flight agents abandoned)");
      process.exit(130);
    }
    interrupted = true;
    rt.log("interrupt — draining in-flight agents, queued calls will not start");
    rt.close();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const fn = new AsyncFunction(...Object.keys(agentGlobals), source);
    const result = await fn(...Object.values(agentGlobals));
    return { runId: rt.runId, meta, result, interrupted, journalPath: rt.journal.path };
  } catch (err) {
    const e = new Error(`workflow failed: ${scriptPath}: ${err.message}`);
    e.cause = err;
    throw e;
  } finally {
    rt.close(); // resolve queued agent() calls so nothing is left pending
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
