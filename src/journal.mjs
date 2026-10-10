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
    return join(Journal.dirFor(cwd), `${runId}.jsonl`);
  }

  static load(path) {
    const meta = { settled: new Map(), ended: null, runStart: null, worktrees: [] };
    if (!existsSync(path)) return meta;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type === 'run-start') meta.runStart = rec;
      else if (rec.type === 'agent') meta.settled.set(rec.i, rec);
      else if (rec.type === 'run-end') meta.ended = rec;
      else if (rec.type === 'worktree') meta.worktrees.push(rec);
    }
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
          ended: rec.ended?.reason ?? 'incomplete',
          pid: rec.runStart?.pid ?? null,
          at: rec.runStart?.at ?? null,
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
