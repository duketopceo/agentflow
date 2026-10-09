import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWorktree, pruneWorktrees, removeWorktree } from "../src/worktree.mjs";
import { gitRepo, tmpDir } from "./helpers.mjs";

// A pid far above any platform's pid_max → guaranteed ESRCH.
const DEAD_PID = 0x3ffffff0;

test("createWorktree creates a detached worktree at HEAD", () => {
  const repo = gitRepo();
  const wt = createWorktree(repo, "test-run", 0);
  assert.ok(wt);
  assert.ok(existsSync(join(wt, "f.txt")));
  removeWorktree(repo, wt);
  assert.equal(existsSync(wt), false);
});

test("createWorktree returns null outside a git repo", () => {
  const dir = tmpDir("af-nogit-");
  assert.equal(createWorktree(dir, "test-run", 0), null);
});

test("pruneWorktrees removes leftovers from killed runs", () => {
  const repo = gitRepo();
  const wt = createWorktree(repo, "killed-run", 0);
  assert.ok(existsSync(wt));
  // Model a killed run: the .live marker names a dead pid.
  writeFileSync(join(repo, ".agentflow", "wt", "killed-run", ".live"), JSON.stringify({ pid: DEAD_PID }));
  const pruned = pruneWorktrees(repo);
  assert.equal(pruned, 1);
  assert.equal(existsSync(wt), false);
});

test("pruneWorktrees skips a live concurrent run's worktrees", () => {
  const repo = gitRepo();
  const wt = createWorktree(repo, "live-run", 0); // .live names our own live pid
  const pruned = pruneWorktrees(repo);
  assert.equal(pruned, 0);
  assert.equal(existsSync(wt), true);
  removeWorktree(repo, wt);
});

test("pruneWorktrees on non-repo returns 0", () => {
  assert.equal(pruneWorktrees(tmpDir("af-nogit-")), 0);
});
