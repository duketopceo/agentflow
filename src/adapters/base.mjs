// Adapter contract (KTD4): spawnAgent(spec) → Promise<{text, json?, exitCode, stderrTail}>
// spec: { prompt, label, model, schema, worktree, cwd, timeout, permission, sandbox }
// Each adapter owns flag mapping and output parsing, plus probe() for doctor (R10).

import { spawn } from "node:child_process";
import { extractJson } from "../schema.mjs";

const STDERR_TAIL = 4000;
// stdout is bounded too: JSONL adapters need the tail (last events win) and a
// runaway child must not grow memory without limit.
const STDOUT_TAIL = 32 * 1024 * 1024;
const KILL_GRACE_MS = 3000;

// Shared subprocess wrapper: captures stdout + stderr tail, enforces timeout
// with SIGTERM → SIGKILL escalation. Resolves (never rejects) so the pool can
// map failures to agent()'s null contract.
export function spawnCli(cmd, argv, { cwd, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // Detached (POSIX): the child leads its own process group, so terminal
      // Ctrl-C reaches only the runner — drain semantics stay intact — and
      // kill(-pid) can reach the whole tree, grandchildren included.
      const detached = process.platform !== "win32";
      child = spawn(cmd, argv, { cwd, env: process.env, detached });
      var killTree = (sig) => {
        try {
          if (detached && child.pid) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch { /* already dead */ }
      };
    } catch (err) {
      return resolve({ code: -1, stdout: "", stderrTail: String(err), timedOut: false, spawnError: true });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(-STDOUT_TAIL), stderrTail: stderr.slice(-STDERR_TAIL), timedOut, spawnError: false });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > STDOUT_TAIL * 2) stdout = stdout.slice(-STDOUT_TAIL);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > STDERR_TAIL * 2) stderr = stderr.slice(-STDERR_TAIL);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code: -1, stdout: stdout.slice(-STDOUT_TAIL), stderrTail: String(err), timedOut: false, spawnError: true });
      }
    });
    child.on("close", (code) => finish(code));
  });
}

// Shared stderr classifier: permission denials and rate limits surface
// distinctly from ordinary failure so a script can report "denied" rather than
// "failed". extraPermission extends the denial pattern per-harness (e.g. codex
// adds |sandbox for sandbox-policy rejections).
export function classifyStderr(raw, extraPermission = "") {
  const tail = raw.stderrTail || "";
  if (new RegExp(`permission|denied|not allowed|requires approval${extraPermission}`, "i").test(tail)) {
    return `permission-denied: ${tail.trim()}`;
  }
  if (/rate.?limit|too many|429|throttl/i.test(tail)) return `rate-limited: ${tail.trim()}`;
  return tail;
}

// Shared result assembly: { text, exitCode, stderrTail } + schema extraction.
// Claude stays custom — it unwraps the --output-format json envelope first.
export function toResult(spec, raw, text, extraPermission = "") {
  const result = { text, exitCode: raw.code, stderrTail: classifyStderr(raw, extraPermission) };
  if (spec.schema) result.json = extractJson(text) ?? null;
  return result;
}

// Binary-on-PATH + flag probe used by `doctor` (R10). helpArgs defaults to
// --help; pass e.g. ["exec", "--help"] to probe a subcommand's flag surface.
export async function probeBinary(bin, versionArgs = ["--version"], helpNeedles = [], helpArgs = ["--help"]) {
  const v = await spawnCli(bin, versionArgs, { timeoutMs: 10_000 });
  if (v.spawnError || v.code !== 0) {
    return { ok: false, detail: (v.stderrTail || "not on PATH").trim().split("\n").at(-1) };
  }
  const version = (v.stdout || v.stderrTail).trim().split("\n")[0];
  const missing = [];
  if (helpNeedles.length) {
    const h = await spawnCli(bin, helpArgs, { timeoutMs: 10_000 });
    const help = h.stdout + "\n" + h.stderrTail;
    for (const needle of helpNeedles) if (!help.includes(needle)) missing.push(needle);
  }
  return { ok: missing.length === 0, version, detail: missing.length ? `flags not found: ${missing.join(", ")}` : null };
}
