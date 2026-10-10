import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SMOKE = fileURLToPath(new URL('../scripts/smoke-harnesses.mjs', import.meta.url));
const run = (args, env = {}) => spawnSync(process.execPath, [SMOKE, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('smoke --only echo --json: free row, PONG, parseable result shape', () => {
  const r = run(['--only', 'echo', '--json']);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'echo');
  assert.equal(rows[0].ok, true);
  assert.match(rows[0].text, /PONG/);
  assert.ok(Number.isFinite(rows[0].latencyMs));
  assert.equal(r.status, 0);
});

test('smoke: absent harness binary yields FAIL row, run continues, exit 1', () => {
  // Stripped PATH -> `which` itself can't run -> binary probe fails cleanly.
  const r = run(['--only', 'devin,echo', '--json'], { PATH: '/nonexistent-xyz' });
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 2);
  const devin = rows.find((x) => x.name === 'devin');
  const echo = rows.find((x) => x.name === 'echo');
  assert.equal(devin.ok, false);
  assert.match(devin.text, /not on PATH/);
  assert.equal(echo.ok, true); // echo is in-process, PATH-proof
  assert.equal(r.status, 1);
});

test('smoke: failing workflow records FAIL with stderr tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-smoke-'));
  try {
    writeFileSync(join(dir, 'bad.mjs'), `throw new Error('script exploded');`);
    const r = run(['--only', 'echo', '--json', '--script', join(dir, 'bad.mjs')]);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].ok, false);
    assert.match(rows[0].text, /FAIL/);
    assert.equal(r.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke markdown mode emits table rows', () => {
  const r = run(['--only', 'echo']);
  assert.match(r.stdout, /\| echo \| `--harness echo` \| PONG \|/);
});
