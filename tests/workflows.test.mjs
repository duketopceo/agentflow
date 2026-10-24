import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScript } from '../src/runtime.mjs';
import echo from '../src/adapters/echo.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'af-wf-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  writeFileSync(join(dir, '.gitignore'), '.agentflow/\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
}

test('audit: audits all matching files and returns a summary', async () => {
  const { dir, cleanup } = makeDir();
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.txt'), 'hello');
    writeFileSync(join(dir, 'src', 'b.txt'), 'world');
    const res = await runScript({
      scriptPath: join(ROOT, 'workflows', 'audit.mjs'),
      adapter: echo,
      cwd: dir,
      args: ['\\.txt$', 'check for TODOs'],
    });
    assert.equal(res.code, 0);
    assert.equal(res.result.files, 2);
    assert.equal(res.result.ok, 2);
    assert.equal(res.result.results.length, 2);
  } finally {
    cleanup();
  }
});

test('migrate: migrates all matching files in parallel worktrees', async () => {
  const { dir, cleanup } = makeDir();
  try {
    gitInit(dir);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.txt'), 'hello');
    writeFileSync(join(dir, 'src', 'b.txt'), 'world');
    const res = await runScript({
      scriptPath: join(ROOT, 'workflows', 'migrate.mjs'),
      adapter: echo,
      cwd: dir,
      args: ['\\.txt$', 'remove TODOs'],
    });
    assert.equal(res.code, 0);
    assert.equal(res.result.files, 2);
    assert.equal(res.result.migrated, 2);
  } finally {
    cleanup();
  }
});
