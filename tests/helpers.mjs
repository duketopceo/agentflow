import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmpDir(prefix = "af-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function gitRepo() {
  const dir = tmpDir("af-repo-");
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "f.txt"), "x");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
  return dir;
}
