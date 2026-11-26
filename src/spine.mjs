import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Debug spine — a per-run JSONL of what the runner did. Local and optional:
// enabled by AGENTFLOW_DEBUG=1 (or runScript({ debug: true })). Written under
// the run journal dir in its own `spine/` namespace, so run discovery only
// ever sees real journals. One line per event, seq + ISO timestamp.
export class Spine {
  constructor(path, enabled) {
    this.path = path;
    this.enabled = enabled;
    this.seq = 0;
    if (!this.enabled) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path)) {
        const text = readFileSync(path, 'utf8');
        const lines = text.trim().split('\n').filter(Boolean);
        const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
        if (Number.isInteger(last?.seq)) this.seq = last.seq;
        // A prior partial write must not glue two JSON objects onto one line.
        if (text && !text.endsWith('\n')) appendFileSync(path, '\n');
      }
    } catch (e) {
      this.#disable(e);
    }
  }

  static create({ path, enabled }) {
    return new Spine(path, enabled);
  }

  #disable(e) {
    this.enabled = false;
    process.stderr.write(`agentflow: debug spine unavailable (${e?.message ?? e})\n`);
  }

  emit(event, data = {}) {
    if (!this.enabled) return;
    this.seq += 1;
    try {
      appendFileSync(this.path, JSON.stringify({ seq: this.seq, t: new Date().toISOString(), event, ...data }) + '\n');
    } catch (e) {
      this.#disable(e);
    }
  }
}
