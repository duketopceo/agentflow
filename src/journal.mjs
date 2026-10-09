// Append-only JSONL run journal keyed by call sequence index (R5, KTD6).
// Each entry also carries a hash of the call spec (prompt + options); resume
// replays a settled result only when the incoming call's hash matches — a
// mismatch warns and re-executes instead of replaying a stale result.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const SPEC_KEYS = ["prompt", "label", "model", "schema", "worktree", "cwd", "timeout", "permission", "sandbox"];

export function specHash(spec) {
  const stable = {};
  for (const k of SPEC_KEYS) if (spec[k] !== undefined) stable[k] = spec[k];
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

export function runsDir(dir) {
  return join(dir, ".agentflow", "runs");
}

export class Journal {
  #dirReady = false;

  constructor(path) {
    this.path = path;
    this.settled = new Map(); // seq -> entry
    let lines;
    try {
      lines = readFileSync(path, "utf8").split("\n");
      this.#dirReady = true;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      lines = [];
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        this.settled.set(entry.seq, entry);
      } catch { /* skip corrupt tail lines */ }
    }
  }

  // Returns { hit: true, entry } when a settled success's spec-hash matches,
  // { hit: false, failed: true } when the matching entry failed (resume
  // retries failures — a transient kill/rate-limit must not freeze as null),
  // { hit: false, mismatch: true } on a spec change, or { hit: false } when
  // the seq was never settled. Accepts a spec or a precomputed hash.
  lookup(seq, specOrHash) {
    const entry = this.settled.get(seq);
    if (!entry) return { hit: false };
    const hash = typeof specOrHash === "string" ? specOrHash : specHash(specOrHash);
    if (entry.specHash !== hash) return { hit: false, mismatch: true };
    return entry.ok ? { hit: true, entry } : { hit: false, failed: true, entry };
  }

  append(entry) {
    if (!this.#dirReady) {
      mkdirSync(dirname(this.path), { recursive: true });
      // Journals hold labels/spec-hashes + full agent output — keep all run
      // state (runs/, wt/) out of whatever repo --dir points at (CWE-538).
      try {
        writeFileSync(join(dirname(this.path), "..", ".gitignore"), "*\n", { flag: "wx" });
      } catch { /* exists or unwritable */ }
      this.#dirReady = true;
    }
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    this.settled.set(entry.seq, entry);
  }
}

export function listRuns(dir) {
  const dirPath = runsDir(dir);
  let files;
  try {
    files = readdirSync(dirPath);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      // Count without retaining entries — listing must not hold every result.
      let calls = 0;
      let ok = 0;
      let lastTs = null;
      for (const line of readFileSync(join(dirPath, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          calls++;
          if (entry.ok) ok++;
          lastTs = entry.ts ?? lastTs;
        } catch { /* skip corrupt tail lines */ }
      }
      return { runId: basename(f, ".jsonl"), calls, ok, failed: calls - ok, lastTs };
    })
    .sort((a, b) => (a.runId < b.runId ? 1 : -1));
}
