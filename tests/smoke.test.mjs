import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SMOKE = fileURLToPath(new URL('../scripts/smoke-harnesses.mjs', import.meta.url));
// Smoke rows spawn real `agentflow run` children — run them from a tmp cwd so
// their journals never land in the repo's .agentflow/runs/.
const SMOKE_CWD = mkdtempSync(join(tmpdir(), 'af-smoke-cwd-'));
after(() => rmSync(SMOKE_CWD, { recursive: true, force: true }));
const run = (args, env = {}) => spawnSync(process.execPath, [SMOKE, ...args], { cwd: SMOKE_CWD, encoding: 'utf8', env: { ...process.env, ...env } });

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

test('smoke markdown mode emits the five-column table', () => {
  const r = run(['--only', 'echo']);
  const row = r.stdout.split('\n').find((l) => l.startsWith('| echo |'));
  assert.ok(row, r.stdout);
  // name | invocation | result | latency | spend — docs/smoke-matrix.md's shape.
  assert.equal(row.split('|').length - 2, 5, row);
  assert.match(row, /\| echo \| `agentflow run smoke\.mjs --harness echo` \| PONG \| [\d.]+s \| none \|/);
});

test('smoke --only matching no rows exits 2 with a clear error', () => {
  const r = run(['--only', 'nonexistent-harness']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /matched no rows/);
});

test('smoke flag swallowing a value exits 2 (--only --json)', () => {
  const r = run(['--only', '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs a value/);
});

test('smoke runs its children in a throwaway cwd (journals land there, not the repo)', () => {
  run(['--only', 'echo', '--json']);
  assert.ok(existsSync(join(SMOKE_CWD, '.agentflow', 'runs')), 'child journal missing from tmp cwd');
});
