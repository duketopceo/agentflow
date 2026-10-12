// agentflow mcp — zero-dependency MCP server over stdio.
//
// MCP's stdio transport is newline-delimited JSON-RPC 2.0: one message per
// line, UTF-8, no Content-Length framing (that is LSP, not MCP). The server
// must keep stdout protocol-clean — diagnostics go to stderr.
//
// Hand-rolled rather than @modelcontextprotocol/sdk because agentflow's
// install paths often clone without `npm install` (plugin manifests, git
// specs, bare checkouts); a bare-clone `agentflow mcp` must still answer.
// The implemented surface is the small stable core: initialize, ping,
// tools/list, tools/call. SDK remains the documented fallback if the
// protocol grows past this.
//
// Tool surface: run/doctor/status/tail/stop — the verbs an agent needs
// mid-run. `watch` needs a TTY; `clean` is destructive; `resume` is an
// argument on run, not a separate tool.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import {
  buildRunArgs, buildDoctorArgs, buildStatusArgs, buildTailArgs, buildStopArgs,
  runAgentflow,
  RUN_DESCRIPTION, DOCTOR_DESCRIPTION, STATUS_DESCRIPTION, TAIL_DESCRIPTION, STOP_DESCRIPTION,
  HARNESS_DESCRIPTION, VIA_DESCRIPTION, SCRIPT_DESCRIPTION, SCRIPT_ARGS_DESCRIPTION,
  RESUME_DESCRIPTION, DETACH_DESCRIPTION, RUN_ID_DESCRIPTION, CWD_DESCRIPTION,
} from './capture.mjs';

// Newest first — negotiation returns the client's version when supported,
// else ours (per spec the server answers with what it can serve).
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const ERR = { PARSE: -32700, INVALID: -32600, NOT_FOUND: -32601, PARAMS: -32602, INTERNAL: -32603 };

const stringProp = (description) => ({ type: 'string', description });
const RUN_ID_PROP = { runId: { ...stringProp(RUN_ID_DESCRIPTION) } };
const CWD_PROP = { cwd: stringProp(CWD_DESCRIPTION) };
const objSchema = (properties, required = []) => ({ type: 'object', properties, required });

const TOOLS = [
  {
    name: 'agentflow_run',
    description: RUN_DESCRIPTION,
    inputSchema: objSchema({
      script: stringProp(SCRIPT_DESCRIPTION),
      harness: stringProp(HARNESS_DESCRIPTION),
      via: stringProp(VIA_DESCRIPTION),
      scriptArgs: stringProp(SCRIPT_ARGS_DESCRIPTION),
      resume: stringProp(RESUME_DESCRIPTION),
      detach: { type: 'boolean', description: DETACH_DESCRIPTION },
      ...CWD_PROP,
    }, ['script']),
  },
  {
    name: 'agentflow_doctor',
    description: DOCTOR_DESCRIPTION,
    inputSchema: objSchema({ ...CWD_PROP }),
  },
  {
    name: 'agentflow_status',
    description: STATUS_DESCRIPTION,
    inputSchema: objSchema({ ...RUN_ID_PROP, ...CWD_PROP }, ['runId']),
  },
  {
    name: 'agentflow_tail',
    description: TAIL_DESCRIPTION,
    inputSchema: objSchema({ ...RUN_ID_PROP, ...CWD_PROP }, ['runId']),
  },
  {
    name: 'agentflow_stop',
    description: STOP_DESCRIPTION,
    inputSchema: objSchema({ ...RUN_ID_PROP, ...CWD_PROP }, ['runId']),
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const textContent = (text) => ({ content: [{ type: 'text', text }] });
const okResult = (text) => textContent(text);
const errResult = (text) => ({ ...textContent(text), isError: true });

// `status`/`tail` exit 2 both for a missing journal (real failure) and for a
// running/orphaned run (a valid answer). The text is the discriminator.
const informational = (r) => (r.out.includes('no journal') ? errResult(r.out) : okResult(r.out));
const strict = (r) => (r.code === 0 ? okResult(r.out) : errResult(r.out));

async function callTool(name, args, ctx) {
  const cwd = args?.cwd ?? ctx.cwd;
  const bin = ctx.bin;
  switch (name) {
    case 'agentflow_run': {
      const r = await runAgentflow(buildRunArgs(args ?? {}), { cwd, bin });
      return strict(r);
    }
    case 'agentflow_doctor':
      return strict(await runAgentflow(buildDoctorArgs(), { cwd, bin }));
    case 'agentflow_status':
      return informational(await runAgentflow(buildStatusArgs(args.runId), { cwd, bin }));
    case 'agentflow_tail':
      return informational(await runAgentflow(buildTailArgs(args.runId), { cwd, bin }));
    case 'agentflow_stop':
      return strict(await runAgentflow(buildStopArgs(args.runId), { cwd, bin }));
  }
}

// One JSON-RPC request -> one response object, or null for notifications.
// Notifications (no id) get no response at all — replying is a spec violation.
async function handle(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: ERR.INVALID, message: 'Invalid Request' } };
  }
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification — never answered

  switch (method) {
    case 'initialize': {
      const wanted = params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(wanted) ? wanted : LATEST_PROTOCOL;
      return result(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'agentflow', version: PKG.version },
      });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      const tool = TOOL_BY_NAME.get(params?.name);
      if (!tool) return err(id, ERR.PARAMS, `unknown tool '${params?.name}'`);
      const args = params?.arguments ?? {};
      for (const req of tool.inputSchema.required ?? []) {
        if (typeof args[req] !== 'string' || !args[req]) {
          return err(id, ERR.PARAMS, `missing required argument '${req}'`);
        }
      }
      try {
        return result(id, await callTool(params.name, args, ctx));
      } catch (e) {
        return result(id, errResult(`agentflow ${params.name} failed: ${e.message}`));
      }
    }
    default:
      return err(id, ERR.NOT_FOUND, `method not found: ${method}`);
  }
}

const result = (id, r) => ({ jsonrpc: '2.0', id, result: r });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// serve() binds stdin/stdout for the life of the process. ctx.bin lets tests
// point at a fake agentflow; ctx.input/output allow in-process embedding.
// Resolves when stdin closes — the CLI's exit code.
export function serve({ input = process.stdin, output = process.stdout, cwd = process.cwd(), bin = 'agentflow' } = {}) {
  const ctx = { cwd, bin };
  const rl = createInterface({ input, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: ERR.PARSE, message: 'Parse error' } }) + '\n');
      return;
    }
    handle(msg, ctx)
      .then((res) => { if (res) output.write(JSON.stringify(res) + '\n'); })
      .catch((e) => output.write(JSON.stringify(err(msg?.id ?? null, ERR.INTERNAL, e.message)) + '\n'));
  });
  return new Promise((resolve) => rl.on('close', resolve));
}
