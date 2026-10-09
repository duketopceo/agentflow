import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { extractJson, classifyFailure, probeBinary, spawnProcess, applyVia } from '../src/adapters/base.mjs';
import devin from '../src/adapters/devin.mjs';
import claude from '../src/adapters/claude.mjs';
import codex from '../src/adapters/codex.mjs';
import opencode from '../src/adapters/opencode.mjs';
import ori from '../src/adapters/ori.mjs';
import { adapters } from '../src/adapters/index.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const spec = (over = {}) => ({ prompt: 'review this file', label: 't', ...over });

test('extractJson: whole body, fenced, embedded, invalid', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":2}\n```\nDone'), { a: 2 });
  assert.deepEqual(extractJson('prefix {"a":3,"b":{"c":1}} suffix'), { a: 3, b: { c: 1 } });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('{invalid'), null);
  assert.equal(extractJson(''), null);
});

test('classifyFailure distinguishes permission denial', () => {
  const denied = classifyFailure({ code: 1, stderr: 'Error: permission required to run exec', stdout: '' }, devin.permissionDeniedPatterns);
  assert.equal(denied.permissionDenied, true);
  const plain = classifyFailure({ code: 1, stderr: 'model exploded', stdout: '' }, devin.permissionDeniedPatterns);
  assert.equal(plain.permissionDenied, false);
  const timeout = classifyFailure({ timedOut: true, stderr: '' }, []);
  assert.equal(timeout.timedOut, true);
});

test('devin buildArgv: flags verified against devin --help', () => {
  const argv = devin.buildArgv(spec({ model: 'devin-lite' }));
  assert.deepEqual(argv.slice(0, 2), ['devin', '-p']);
  assert.equal(argv[2], 'review this file');
  assert.ok(argv.includes('--respect-workspace-trust') && argv.includes('false'));
  assert.ok(argv.includes('--permission-mode') && argv.includes('smart'));
  assert.ok(argv.includes('--model') && argv.includes('devin-lite'));
});

test('devin permission mapping: escalated -> dangerous', () => {
  const argv = devin.buildArgv(spec({ permission: 'escalated' }));
  assert.ok(argv.includes('dangerous'));
});

test('devin parse: stdout text, schema extraction', () => {
  const r = devin.parse({ stdout: 'All good.\n```json\n{"ok":true}\n```' }, spec({ schema: { type: 'object' } }));
  assert.deepEqual(r.json, { ok: true });
  const plain = devin.parse({ stdout: 'text only' }, spec());
  assert.equal(plain.text, 'text only');
});

test('claude buildArgv + parse json envelope', () => {
  const argv = claude.buildArgv(spec({ model: 'sonnet' }));
  assert.deepEqual(argv.slice(0, 2), ['claude', '-p']);
  assert.ok(argv.includes('--output-format') && argv.includes('json'));
  assert.ok(argv.includes('--model') && argv.includes('sonnet'));
  const r = claude.parse({ stdout: '{"type":"result","result":"done here"}' }, spec());
  assert.equal(r.text, 'done here');
});

test('codex buildArgv: exec, sandbox, schema file, worktree', () => {
  const argv = codex.buildArgv(spec({ model: 'gpt-5', worktree: true, schema: { type: 'object' } }), { schemaFile: '/tmp/s.json', lastMsgFile: '/tmp/m.txt' });
  assert.deepEqual(argv.slice(0, 2), ['codex', 'exec']);
  assert.ok(argv.includes('-s') && argv.includes('workspace-write'));
  assert.ok(argv.includes('--output-schema') && argv.includes('/tmp/s.json'));
  assert.ok(argv.includes('-o') && argv.includes('/tmp/m.txt'));
  assert.ok(argv.includes('--worktree'));
  assert.equal(argv.at(-1), 'review this file');
  const esc = codex.buildArgv(spec({ permission: 'escalated' }), {});
  assert.ok(esc.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('opencode buildArgv + parse json event stream', () => {
  const argv = opencode.buildArgv(spec({ model: 'anthropic/claude-haiku', cwd: '/tmp/x', permission: 'escalated' }));
  assert.deepEqual(argv.slice(0, 3), ['opencode', 'run', 'review this file']);
  assert.ok(argv.includes('--format') && argv.includes('json'));
  assert.ok(argv.includes('-m') && argv.includes('anthropic/claude-haiku'));
  assert.ok(argv.includes('--dir') && argv.includes('/tmp/x'));
  assert.ok(argv.includes('--auto'));

  const stream = readFileSync(join(FIXTURES, 'opencode-events.jsonl'), 'utf8');
  const r = opencode.parse({ stdout: stream }, spec());
  assert.equal(r.text, 'first partsecond part');
});

test('opencode parse tolerates malformed lines', () => {
  const r = opencode.parse({ stdout: 'garbage\n{"type":"text","part":{"text":"real"}}\n{bad' }, spec());
  assert.equal(r.text, 'real');
});

test('ori buildArgv: code -p, self-drive approvals, openrouter model slug', () => {
  const argv = ori.buildArgv(spec({ model: 'x-ai/grok-4-fast' }));
  assert.deepEqual(argv.slice(0, 2), ['ori', 'code']);
  assert.ok(argv.includes('--prompt') && argv.includes('review this file'));
  assert.ok(argv.includes('--output') && argv.includes('text'));
  assert.ok(argv.includes('--approvals') && argv.includes('self-drive'));
  assert.ok(argv.includes('--model') && argv.includes('x-ai/grok-4-fast'));
});

test('ori parse: stdout text, schema extraction', () => {
  const r = ori.parse({ stdout: 'Result.\n```json\n{"ok":true}\n```' }, spec({ schema: { type: 'object' } }));
  assert.deepEqual(r.json, { ok: true });
});

test('applyVia wraps wrappable harnesses, rejects others, direct is noop', () => {
  const argv = claude.buildArgv(spec());
  assert.deepEqual(applyVia(claude, argv, spec({ via: 'ori' })).argv.slice(0, 2), ['ori', 'claude']);
  assert.deepEqual(applyVia(opencode, opencode.buildArgv(spec()), spec({ via: 'ori' })).argv.slice(0, 2), ['ori', 'opencode']);
  assert.ok(applyVia(devin, devin.buildArgv(spec()), spec({ via: 'ori' })).error);
  assert.deepEqual(applyVia(claude, argv, spec({ via: 'direct' })).argv[0], 'claude');
  assert.deepEqual(applyVia(claude, argv, spec()).argv[0], 'claude');
  // already-on-ori adapter is a noop, not a double-wrap
  assert.deepEqual(applyVia(ori, ori.buildArgv(spec()), spec({ via: 'ori' })).argv.slice(0, 2), ['ori', 'code']);
  // reasoningEffort injects into the ori-consumed position after the harness name
  const w = applyVia(claude, argv, spec({ via: 'ori', reasoningEffort: 'high' })).argv;
  assert.deepEqual(w.slice(0, 4), ['ori', 'claude', '--reasoning-effort', 'high']);
});

test('ori reasoningEffort emits native flag', () => {
  assert.ok(ori.buildArgv(spec({ reasoningEffort: 'low' })).includes('low'));
});

test('adapter registry exposes all six harnesses', () => {
  assert.deepEqual(Object.keys(adapters).sort(), ['claude', 'codex', 'devin', 'echo', 'opencode', 'ori']);
});

test('probeBinary reports missing binary without throwing', async () => {
  const p = await probeBinary({ name: 'ghost', bin: 'agentflow-no-such-bin-xyz', requiredFlags: [] });
  assert.equal(p.ok, false);
  assert.match(p.notes[0], /not on PATH/);
});

test('spawnProcess captures stdout, exit code, and timeout', async () => {
  const ok = await spawnProcess(['node', '-e', 'console.log("hi")'], {});
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), 'hi');
  const slow = await spawnProcess(['node', '-e', 'setTimeout(()=>{},5000)'], { timeout: 100 });
  assert.equal(slow.timedOut, true);
});
