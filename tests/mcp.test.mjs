// MCP server contract tests — spawns the real `bin/agentflow mcp` over stdio
// with PATH pointed at tests/fakebin so tool calls hit the fake agentflow
// (stderr-only `run`, stdout `doctor`) without touching a real harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = resolve(REPO, 'bin/agentflow');
const FAKEBIN = resolve(REPO, 'tests/fakebin');

function mcpClient(extraEnv = {}) {
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    env: { ...process.env, PATH: `${FAKEBIN}:${process.env.PATH}`, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume(); // keep the pipe drained; protocol lives on stdout
  const lines = [];
  let waiters = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl === -1) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      lines.push(JSON.parse(line));
      for (const w of waiters) w();
      waiters = [];
    }
  });
  return {
    send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); },
    sendRaw(text) { child.stdin.write(text + '\n'); },
    // Wait for the response frame carrying a given id (or any error with that id).
    async reply(id, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = lines.find((m) => m.id === id);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`no reply for id ${id}; saw ${JSON.stringify(lines)}`);
        await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
      }
    },
    close() { child.stdin.end(); child.kill(); },
  };
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };

test('initialize negotiates a supported protocolVersion and advertises tools', async (t) => {
  const c = mcpClient();
  t.after(() => c.close());
  c.send(init);
  const res = await c.reply(1);
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.equal(res.result.serverInfo.name, 'agentflow');
  assert.match(res.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  assert.ok('tools' in res.result.capabilities);
});

test('initialize falls back to our latest version for unknown client versions', async (t) => {
  const c = mcpClient();
  t.after(() => c.close());
  c.send({ ...init, params: { ...init.params, protocolVersion: '1999-01-01' } });
  const res = await c.reply(1);
  assert.equal(res.result.protocolVersion, '2025-06-18');
});

test('tools/list returns exactly the five tools with inputSchemas', async (t) => {
  const c = mcpClient();
  t.after(() => c.close());
  c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const res = await c.reply(2);
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['agentflow_doctor', 'agentflow_run', 'agentflow_status', 'agentflow_stop', 'agentflow_tail']);
  for (const tool of res.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema`);
  }
  assert.deepEqual(res.result.tools.find((t) => t.name === 'agentflow_run').inputSchema.required, ['script']);
});

test('tools/call agentflow_run captures stderr-only output and returns the run-id', async (t) => {
  const c = mcpClient();
  t.after(() => c.close());
  c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agentflow_run', arguments: { script: 'w.mjs', harness: 'echo' } } });
  const res = await c.reply(3);
  const text = res.result.content[0].text;
  assert.ok(text.includes('run fake-run-0001'), `run-id must survive: ${text}`);
  assert.ok(text.includes('RESULT'), text);
  assert.equal(res.result.isError, undefined);
});

test('tools/call run builds argv in runner order via the shared builder', async (t) => {
  const argvFile = join(tmpdir(), `mcp-argv-${process.pid}-${Date.now()}.jsonl`);
  const c = mcpClient({ AGENTFLOW_FAKE_ARGV_FILE: argvFile });
  t.after(() => c.close());
  c.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agentflow_run', arguments: { script: 'w.mjs', harness: 'echo', resume: 'r-1', scriptArgs: 'a b' } } });
  const res = await c.reply(4);
  assert.equal(res.result.isError, undefined);
  const argv = JSON.parse(readFileSync(argvFile, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(argv, ['run', 'w.mjs', '--harness', 'echo', '--resume', 'r-1', '--', 'a b']);
});

test('tools/call run surfaces a failed run as isError, not a clean result', async (t) => {
  const c = mcpClient({ AGENTFLOW_FAKE_EXIT: '3' });
  t.after(() => c.close());
  c.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agentflow_run', arguments: { script: 'w.mjs' } } });
  const res = await c.reply(5);
  assert.equal(res.result.isError, true);
  assert.ok(res.result.content[0].text.includes('FAKED'), res.result.content[0].text);
});

test('tools/call doctor returns probe output through the same path', async (t) => {
  const c = mcpClient();
  t.after(() => c.close());
  c.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'agentflow_doctor', arguments: {} } });
  const res = await c.reply(6);
  assert.ok(res.result.content[0].text.includes('ok'), res.result.content[0].text);
  assert.equal(res.result.isError, undefined);
});

test('tools/call status/tail/stop place runId positionally', async (t) => {
  const argvFile = join(tmpdir(), `mcp-argv-${process.pid}-${Date.now()}.jsonl`);
  const c = mcpClient({ AGENTFLOW_FAKE_ARGV_FILE: argvFile });
  t.after(() => c.close());
  for (const [id, name] of [[7, 'agentflow_status'], [8, 'agentflow_tail'], [9, 'agentflow_stop']]) {
    c.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { runId: 'r-9' } } });
    await c.reply(id);
  }
  const argvLines = readFileSync(argvFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(argvLines, [['status', 'r-9'], ['tail', 'r-9'], ['stop', 'r-9']]);
});

test('tools/call missing required arg -> -32602 without spawning', async (t) => {
  const c = mcpClient({ AGENTFLOW_FAKE_ARGV_FILE: join(tmpdir(), `mcp-never-${process.pid}`) });
  t.after(() => c.close());
  c.send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'agentflow_run', arguments: {} } });
  const res = await c.reply(10);
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /script/);
});

test('unknown tool -> -32602; unknown method -> -32601', async (t) => {
  const c = mcpClient();
  t.after(() => c.close());
  c.send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal((await c.reply(11)).error.code, -32602);
  c.send({ jsonrpc: '2.0', id: 12, method: 'resources/list', params: {} });
  assert.equal((await c.reply(12)).error.code, -32601);
});

test('malformed JSON -> -32700; notifications get no response frame', async (t) => {
  const c = mcpClient();
  t.after(() => c.close());
  c.sendRaw('{not json');
  const res = await c.reply(null);
  assert.equal(res.error.code, -32700);
  // notification (no id) must not be answered — send a follow-up request and
  // assert the only frame with its id is its own reply (no stray response).
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  c.send({ jsonrpc: '2.0', id: 13, method: 'ping', params: {} });
  const pong = await c.reply(13);
  assert.deepEqual(pong.result, {});
});

test('ENOENT bin surfaces "not found on PATH", not a bare exit code', async (t) => {
  const c = mcpClient({ PATH: '/nonexistent-dir' });
  t.after(() => c.close());
  c.send({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'agentflow_run', arguments: { script: 'w.mjs' } } });
  const res = await c.reply(14);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /not found on PATH/);
});

test('every manifest wires the canonical agentflow mcp server', async () => {
  const read = (p) => JSON.parse(readFileSync(resolve(REPO, p), 'utf8'));
  const EXPECTED = { command: 'agentflow', args: ['mcp'] };

  // Canonical .mcp.json at repo root — the convention file for Claude/Codex/
  // Cursor project-level discovery.
  assert.deepEqual(read('.mcp.json').mcpServers.agentflow, EXPECTED);

  // Path-reference form (Claude Code, Codex plugin manifests).
  for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    const ref = read(manifest).mcpServers;
    assert.equal(typeof ref, 'string', `${manifest}: path ref expected`);
    const target = read(ref.replace(/^\.\//, ''));
    assert.deepEqual(target.mcpServers.agentflow, EXPECTED, `${manifest} -> ${ref}`);
  }

  // Inline-object form (Cursor, Factory, Gemini extension manifests).
  for (const manifest of ['.cursor-plugin/plugin.json', '.factory-plugin/plugin.json', 'gemini-extension.json']) {
    assert.deepEqual(read(manifest).mcpServers.agentflow, EXPECTED, `${manifest}`);
  }
});
