// Runner-managed git worktree isolation (U5). Worktrees are created from HEAD —
// uncommitted changes are not visible to worktree agents — and are scratch-only:
// edits are discarded on settle via `git worktree remove --force`, never merged.
// Leftover worktrees from killed runs are pruned on runner start.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const repoCache = new Map();
// Bounded wait on every git call — a wedged git must not hang the CLI.
const GIT_OPTS = { stdio: "pipe", timeout: 30_000, killSignal: "SIGKILL" };

function isGitRepo(dir) {
  if (!repoCache.has(dir)) {
    let ok = false;
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, ...GIT_OPTS });
      ok = true;
    } catch { /* not a repo */ }
    repoCache.set(dir, ok);
  }
  return repoCache.get(dir);
}

export function createWorktree(dir, runId, idx) {
  if (!isGitRepo(dir)) return null;
  const runDir = join(dir, ".agentflow", "wt", runId);
  mkdirSync(runDir, { recursive: true });
  // Liveness marker: pruneWorktrees skips a run's worktrees while its pid is
  // alive, so a concurrent run can't sweep this one's in-flight trees.
  try {
    writeFileSync(join(runDir, ".live"), JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
  } catch { /* best effort — prune treats a missing marker as dead anyway */ }
  const wtPath = join(runDir, `a${idx}`);
  try {
    execFileSync("git", ["worktree", "add", "--detach", wtPath, "HEAD"], { cwd: dir, ...GIT_OPTS });
    return wtPath;
  } catch {
    return null;
  }
}

export function removeWorktree(dir, wtPath) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: dir, ...GIT_OPTS });
    return true;
  } catch {
    return false;
  }
}

// Is the run that owns wt/<runId>/ still alive? A .live marker holds its pid;
// dead pid (or missing/garbage marker) means the tree is safe to sweep.
function runIsLive(root, runId) {
  try {
    const { pid } = JSON.parse(readFileSync(join(root, runId, ".live"), "utf8"));
    if (typeof pid !== "number") return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but owned by another user
  }
}

// Remove leftover worktrees under .agentflow/wt/ from killed runs. Worktrees
// belonging to a run whose .live pid is still alive are skipped, so concurrent
// runs in the same dir don't destroy each other's in-flight trees.
export function pruneWorktrees(dir) {
  // Cheap stat gate first — skips the git subprocess entirely for non-repos
  // and runs with no leftovers. git reports real paths, so resolve dir (e.g.
  // /var vs /private/var on macOS) before prefix-matching.
  const root = join(dir, ".agentflow", "wt");
  if (!existsSync(root) || !isGitRepo(dir)) return 0;
  const realRoot = join(realpathSync(dir), ".agentflow", "wt");
  let removed = 0;
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: dir, encoding: "utf8", timeout: GIT_OPTS.timeout, killSignal: GIT_OPTS.killSignal });
    for (const line of out.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const wt = line.slice(9);
      // Boundary-check with the separator so .agentflow/wt-something siblings
      // don't match.
      if (wt !== realRoot && !wt.startsWith(realRoot + sep)) continue;
      const runId = relative(realRoot, wt).split(sep)[0];
      if (runId && runIsLive(realRoot, runId)) continue; // live concurrent run
      if (removeWorktree(dir, wt)) removed++;
    }
  } catch { /* best effort */ }
  // Sweep dead-marker run dirs (stale .live files, empty parents).
  try {
    for (const runId of readdirSync(realRoot)) {
      if (runId.startsWith(".")) continue;
      if (!runIsLive(realRoot, runId)) rmSync(join(realRoot, runId), { recursive: true, force: true });
    }
  } catch { /* best effort */ }
  return removed;
}
