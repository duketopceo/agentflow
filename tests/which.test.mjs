import test from 'node:test';
import assert from 'node:assert/strict';
import { which, winCandidates } from '../src/adapters/which.mjs';
import { parseCmdShim, escapeForCmd, cmdUnsafeReason } from '../src/winproc.mjs';
import { resolveModel } from '../src/adapters/claude.mjs';
import claude from '../src/adapters/claude.mjs';

const PATHEXT = '.COM;.EXE;.BAT;.CMD';

test('winCandidates: tries each PATHEXT ext then the bare name', () => {
  assert.deepEqual(winCandidates('claude', PATHEXT), ['claude.COM', 'claude.EXE', 'claude.BAT', 'claude.CMD', 'claude']);
  assert.deepEqual(winCandidates('claude.cmd', PATHEXT)[0], 'claude.cmd');
});

test('which (win32): walks PATH with ; and win32 separators, honours PATHEXT order', async () => {
  const present = new Set(['C:\\bin2\\claude.CMD', 'C:\\bin2\\claude.EXE', 'C:\\bin1\\other.EXE']);
  const opts = { platform: 'win32', env: { PATH: 'C:\\bin1;;"C:\\bin2"', PATHEXT }, exists: (p) => present.has(p) };
  assert.equal(await which('claude', opts), 'C:\\bin2\\claude.EXE');
  present.delete('C:\\bin2\\claude.EXE');
  assert.equal(await which('claude', opts), 'C:\\bin2\\claude.CMD');
  assert.equal(await which('nope', opts), null);
});

test('which (win32): absolute path gets extension probing, no X_OK', async () => {
  const opts = { platform: 'win32', env: { PATHEXT }, exists: (p) => p === 'C:\\x\\tool.BAT' };
  assert.equal(await which('C:\\x\\tool', opts), 'C:\\x\\tool.BAT');
});

test('which (posix): unchanged — finds only executables on PATH', async () => {
  if (process.platform === 'win32') return;
  assert.ok(await which('node'));
  assert.equal(await which('definitely-not-a-binary-xyz'), null);
});

test('parseCmdShim: npm shim to js and to exe', () => {
  const js = '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@x\\cli\\cli.js" %*\r\n';
  const r = parseCmdShim('C:\\npm\\x.cmd', js);
  assert.equal(r.args[0], 'C:\\npm\\node_modules\\@x\\cli\\cli.js');
  const exe = '@echo off\r\n"%dp0%\\node_modules\\x\\bin\\x.exe"   %*\r\n';
  assert.deepEqual(parseCmdShim('C:\\npm\\x.cmd', exe), { file: 'C:\\npm\\node_modules\\x\\bin\\x.exe', args: [] });
  assert.equal(parseCmdShim('C:\\npm\\x.cmd', '@echo hi\r\n'), null);
});

test('cmd escaping: metacharacters are caret-escaped; newline / %VAR% are rejected', () => {
  const e = escapeForCmd('a & b "q"');
  assert.ok(!/[^\^]&/.test(e), e); // every & is preceded by ^
  assert.ok(cmdUnsafeReason(['line1\nline2']));
  assert.ok(cmdUnsafeReason(['%PATH%']));
  assert.equal(cmdUnsafeReason(['100% sure', 'a&b']), null);
});

test('claude model aliases: cheap/default map, real names pass through', () => {
  assert.equal(resolveModel('cheap'), 'haiku');
  assert.equal(resolveModel('default'), 'sonnet');
  assert.equal(resolveModel('claude-opus-4-1'), 'claude-opus-4-1');
  const argv = claude.buildArgv({ prompt: 'p', model: 'cheap' });
  assert.equal(argv[argv.indexOf('--model') + 1], 'haiku');
});
