import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeTaskQueue, taskQueueLauncher, TASK_QUEUE_SPEC } from '../src/taskqueue.mjs';

const BIN = fileURLToPath(new URL('../bin/agentflow', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function stub(dir, name) {
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
}

// probeTaskQueue resolves binaries through PATH; point PATH at a scratch dir
// so the test controls exactly which launchers exist.
async function withPath(dirs, fn) {
  const saved = process.env.PATH;
  try {
    process.env.PATH = dirs.join(':');
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

test('taskQueueLauncher pins the PyPI spec (never @latest)', () => {
  const l = taskQueueLauncher();
  assert.equal(l.command, 'uvx');
  assert.deepEqual(l.args, [TASK_QUEUE_SPEC]);
  assert.match(TASK_QUEUE_SPEC, /^agent-task-queue@\d+\.\d+\.\d+$/);
});

test('probeTaskQueue: uvx on PATH reports available', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'af-tq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const uvx = stub(dir, 'uvx');
  const p = await withPath([dir], () => probeTaskQueue());
  assert.equal(p.available, true);
  assert.equal(p.path, uvx);
});

test('probeTaskQueue: uv alone still counts (uv tool run)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'af-tq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  stub(dir, 'uv');
  const p = await withPath([dir], () => probeTaskQueue());
  assert.equal(p.available, true);
});

test('probeTaskQueue: neither launcher reports unavailable with guidance', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'af-tq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = await withPath([dir], () => probeTaskQueue());
  assert.equal(p.available, false);
  assert.match(p.notes.join(' '), /uvx not on PATH/);
});

// Doctor's task-queue line is informational: present regardless of launcher,
// never a FAIL row, never changes the exit code.
test('doctor prints a non-fatal task-queue note', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'af-tq-doctor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${dir}` };
  const { code, out } = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, 'doctor'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`doctor timeout\n${out}${err}`)); }, 15000);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
  assert.match(out, /^note task-queue \(not found\)$/m);
  assert.doesNotMatch(out, /^FAIL task-queue/m);
  assert.equal(code, 1, 'exit code still driven by adapter probes (none on PATH), not the queue note');
});

// The worker prompts are the actual delivery mechanism — the queue rule must
// exist verbatim in both harness variants.
for (const rel of ['agents/worker.md', 'droids/worker.md']) {
  test(`${rel} instructs workers to route expensive commands through run_task`, () => {
    const body = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(body, /run_task/);
    assert.match(body, /queue_name: "shared"/);
    assert.match(body, /task_status/);
    assert.match(body, /not available, run the command normally/);
  });
}
