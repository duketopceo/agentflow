import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/agentflow', import.meta.url));

// Spawn the real CLI; capture output and exit code. Detach is the one place
// the suite forks a real process — always against the echo adapter.
function cli(args, cwd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errOut = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (errOut += d));
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`cli timeout: ${args.join(' ')}\n${out}${errOut}`)); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err: errOut }); });
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'af-cli-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    write(name, src) { writeFileSync(join(dir, name), src); return name; },
  };
}

const SCRIPT = `export const meta = { name: 'w' };
phase('p');
const a = await agent('x', {label:'a'});
const b = await agent('y', {label:'b'});
log('RESULT:' + JSON.stringify([a.text, b.text]));`;

test('--detach: parent returns run-id immediately; child completes and journals', async () => {
  const f = fixture();
  try {
    f.write('w.mjs', SCRIPT);
    const t0 = Date.now();
    const r = await cli(['run', 'w.mjs', '--harness', 'echo', '--detach'], f.dir);
    assert.equal(r.code, 0);
    const runId = r.out.match(/run (\S+) \(detached/)?.[1];
    assert.ok(runId, `expected run id in output: ${r.out}`);
    assert.ok(Date.now() - t0 < 5000); // parent doesn't wait for the run

    // Child writes the journal + run-end on its own; status exits 2 while running.
    let status;
    for (let i = 0; i < 60; i++) {
      status = await cli(['status', runId], f.dir);
      if (status.code !== 2) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.equal(status.code, 0); // ended ok
    assert.ok(status.out.includes('a:ok') && status.out.includes('b:ok'));
    assert.ok(status.out.includes('ended: ok'));

    // tail on a finished run prints events and exits promptly.
    const tail = await cli(['tail', runId], f.dir, 8000);
    assert.equal(tail.code, 0);
    assert.ok(tail.out.includes('a -> ok') && tail.out.includes('run ended: ok'));

    // status on unknown run-id fails cleanly.
    const bad = await cli(['status', 'nope'], f.dir);
    assert.equal(bad.code, 2);
  } finally {
    f.cleanup();
  }
});

test('run --run-id honors a caller-provided run id', async () => {
  const f = fixture();
  try {
    f.write('w.mjs', SCRIPT);
    const r = await cli(['run', 'w.mjs', '--harness', 'echo', '--run-id', 'fixed-id-1'], f.dir);
    assert.equal(r.code, 0);
    assert.ok(existsSync(join(f.dir, '.agentflow', 'runs', 'fixed-id-1.jsonl')));
  } finally {
    f.cleanup();
  }
});
