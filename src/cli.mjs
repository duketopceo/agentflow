// agentflow CLI: run / list / doctor (R1, R10).

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listRuns } from "./journal.mjs";
import { runScript } from "./runtime.mjs";
import * as claude from "./adapters/claude.mjs";
import * as codex from "./adapters/codex.mjs";
import * as devin from "./adapters/devin.mjs";
import * as echo from "./adapters/echo.mjs";
import * as opencode from "./adapters/opencode.mjs";

const ADAPTERS = { devin, claude, codex, opencode, echo };
const NODE_MIN = 20;

const USAGE = `agentflow — cross-harness dynamic workflows

Usage:
  agentflow run <script.mjs> [flags] [-- script-args]
  agentflow list
  agentflow doctor

Flags for run:
  --harness <name>       devin | claude | codex | opencode | echo (default: config or "devin")
  --concurrency <n>      max parallel agent() calls (default: config or 8)
  --dir <path>           working directory / journal root (default: cwd)
  --run-id <id>          explicit run id
  --resume <run-id>      replay settled calls from a prior run's journal
  --permission <level>   run-level escalation ceiling: default | escalated (default: "default")
  --live                 allow the script's opt-in live-harness paths
`;

const VALUE_FLAGS = new Set(["harness", "concurrency", "dir", "run-id", "resume", "permission"]);
const BOOL_FLAGS = new Set(["live"]);

function parseFlags(argv) {
  const flags = {};
  const pos = [];
  const scriptArgs = [];
  let inScriptArgs = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (inScriptArgs) { scriptArgs.push(a); continue; }
    if (a === "--") { inScriptArgs = true; continue; }
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const eq = a.indexOf("=");
    const name = (eq === -1 ? a.slice(2) : a.slice(2, eq));
    if (BOOL_FLAGS.has(name)) {
      if (eq === -1) flags[name] = true;
      else {
        const v = a.slice(eq + 1);
        if (v !== "true" && v !== "false") process.stderr.write(`warn: --${name} expects true|false; treating '${v}' as true\n`);
        flags[name] = v !== "false";
      }
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined) process.stderr.write(`warn: --${name} needs a value; ignoring\n`);
      else flags[name] = v;
      continue;
    }
    process.stderr.write(`warn: unknown flag --${name} ignored\n`);
  }
  return { flags, pos, scriptArgs };
}

function loadConfig(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "agentflow.json"), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") process.stderr.write(`[agentflow] warn: ignoring invalid agentflow.json: ${e.message}\n`);
    return {};
  }
}

export async function main(argv) {
  const cmd = argv[0];
  const { flags, pos, scriptArgs } = parseFlags(argv.slice(1));

  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (cmd === "doctor") return doctor();
  if (cmd === "list") return list(flags.dir ? resolve(flags.dir) : process.cwd());
  if (cmd === "run") return run(pos[0], flags, scriptArgs);

  process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
  return 1;
}

async function run(scriptPath, flags, scriptArgs) {
  if (!scriptPath) {
    process.stderr.write("run requires a script path\n");
    return 1;
  }
  const dir = resolve(flags.dir ?? process.cwd());
  const cfg = loadConfig(dir);
  const harness = flags.harness ?? cfg.harness ?? "devin";
  const adapter = ADAPTERS[harness];
  if (!adapter) {
    process.stderr.write(`unknown harness: ${harness} (expected one of ${Object.keys(ADAPTERS).join(", ")})\n`);
    return 1;
  }
  const permission = flags.permission ?? cfg.permission ?? "default";
  if (!["default", "escalated"].includes(permission)) {
    process.stderr.write(`unknown permission ceiling: ${permission} (expected default|escalated)\n`);
    return 1;
  }
  const perHarness = cfg.maxConcurrency?.[harness];
  const concurrency = Number(flags.concurrency ?? perHarness ?? cfg.concurrency ?? 8);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    process.stderr.write(`invalid concurrency: ${flags.concurrency ?? perHarness ?? cfg.concurrency} (expected a positive integer)\n`);
    return 1;
  }

  try {
    const { runId, result, interrupted, journalPath } = await runScript(scriptPath, {
      dir,
      adapter,
      concurrency,
      permission,
      resumeId: flags.resume,
      runId: flags["run-id"],
      live: Boolean(flags.live),
      scriptArgs,
    });
    process.stdout.write(`\nrun ${runId}${interrupted ? " (interrupted — resumable)" : ""}\njournal: ${journalPath}\n`);
    if (result !== undefined) {
      let out;
      try {
        out = JSON.stringify(result, null, 2);
      } catch {
        out = String(result); // circular/BigInt results still print, not "workflow failed"
      }
      process.stdout.write(`result: ${out}\n`);
    }
    return interrupted ? 130 : 0;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

function list(dir) {
  const runs = listRuns(dir);
  if (!runs.length) {
    process.stdout.write("no runs recorded\n");
    return 0;
  }
  for (const r of runs) {
    process.stdout.write(`${r.runId}  calls=${r.calls} ok=${r.ok} failed=${r.failed} last=${r.lastTs ?? "-"}\n`);
  }
  return 0;
}

async function doctor() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  process.stdout.write(`node ${process.versions.node} ${nodeMajor >= NODE_MIN ? "ok" : `FAIL — requires >= ${NODE_MIN}`}\n`);
  let ok = nodeMajor >= NODE_MIN;
  const names = Object.keys(ADAPTERS);
  const probes = await Promise.all(names.map((n) => ADAPTERS[n].probe()));
  names.forEach((name, i) => {
    const p = probes[i];
    const status = p.ok ? `ok (${p.version ?? "present"})` : `missing${p.detail ? `: ${p.detail}` : ""}`;
    process.stdout.write(`${name.padEnd(10)} ${status}\n`);
    if (!p.ok) ok = false;
  });
  return ok ? 0 : 1;
}
