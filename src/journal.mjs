import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// JSONL run journal at .agentflow/runs/<run-id>.jsonl.
// Line 1: run-start. Each settled agent() call: one 'agent' record.
// Last line on exit: run-end. Resume replays settled records by call index.
export class Journal {
  static dirFor(cwd) {
    return join(cwd, '.agentflow', 'runs');
  }

  static newRunId() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + randomUUID().slice(0, 8);
  }

  static create(cwd, meta) {
    const dir = Journal.dirFor(cwd);
    mkdirSync(dir, { recursive: true });
    const j = new Journal(join(dir, `${meta.runId}.jsonl`));
    j.append({ type: 'run-start', ...meta, at: new Date().toISOString() });
    return j;
  }

  static pathFor(cwd, runId) {
    // run-ids build filesystem paths — whitelist before join() or a '../' id
    // escapes .agentflow/runs/ (and .agentflow/worktrees/ in runtime.mjs).
    if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(runId) || runId.includes('..'))
      throw new Error(`invalid run-id '${runId}'`);
    return join(Journal.dirFor(cwd), `${runId}.jsonl`);
  }

  static load(path) {
    const meta = { settled: new Map(), ended: null, runStart: null, worktrees: [], batches: [], inFlight: new Map(), batchPolls: [], usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, steps: 0, calls: 0 } };
    if (!existsSync(path)) return meta;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type === 'run-start') { meta.runStart = rec; meta.ended = null; } // resume epoch: a new run-start supersedes any earlier run-end
      else if (rec.type === 'agent') {
        meta.settled.set(rec.i, rec);
        // Per-call token usage (adapters attach it on result or error) sums
        // into run totals for status/watch. Absent on adapters without a
        // usage feed — calls counts only calls that reported.
        const u = rec.result?.usage ?? rec.error?.usage;
        if (u) {
          meta.usage.promptTokens += u.promptTokens ?? 0;
          meta.usage.completionTokens += u.completionTokens ?? 0;
          meta.usage.cachedTokens += u.cachedTokens ?? 0;
          meta.usage.steps += u.steps ?? 0;
          meta.usage.calls++;
        }
      }
      else if (rec.type === 'run-end') meta.ended = rec;
      else if (rec.type === 'worktree') meta.worktrees.push(rec);
      else if (rec.type === 'batch') meta.batches.push(rec);
      // Progress records — watch/status render these; replay ignores them.
      else if (rec.type === 'in-flight') meta.inFlight.set(rec.i, rec);
      else if (rec.type === 'batch-poll') meta.batchPolls.push(rec);
    }
    for (const i of meta.inFlight.keys()) if (meta.settled.has(i)) meta.inFlight.delete(i);
    return meta;
  }

  static list(cwd) {
    const dir = Journal.dirFor(cwd);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => {
        const rec = Journal.load(join(dir, f));
        return {
          runId: f.replace(/\.jsonl$/, ''),
          script: rec.runStart?.script ?? null,
          harness: rec.runStart?.harness ?? null,
          settled: rec.settled.size,
          ended: rec.ended?.reason ?? null, // null = not ended (display layer renders 'incomplete'/'orphaned')
          pid: rec.runStart?.pid ?? null,
          at: rec.runStart?.at ?? null,
          worktrees: rec.worktrees,
        };
      });
  }

  constructor(path) {
    this.path = path;
  }

  append(record) {
    appendFileSync(this.path, JSON.stringify(record) + '\n');
  }
}
