import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.mjs';
import { extractJson, spawnProcess } from '../src/adapters/base.mjs';
import { runScript } from '../src/runtime.mjs';

const BIN = fileURLToPath(new URL('../bin/agentflow', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'af-hard-'));

test('journal: resume after a crash mid-write keeps the new run-start on its own line', () => {
  const dir = tmp();
  try {
    const j = Journal.create(dir, { runId: 'r', script: 's.mjs', harness: 'echo', pid: 1 });
    j.append({ type: 'agent', i: 0, label: 'a', ok: true, result: { text: 'x' } });
    appendFileSync(j.path, '{"type":"agent","i":1,"label":"b","ok":tr'); // torn write, no newline
    Journal.create(dir, { runId: 'r', script: 's.mjs', harness: 'echo', pid: 2, resumed: true });
    const loaded = Journal.load(j.path);
    assert.equal(loaded.runStart?.pid, 2, 'resumed run-start must not be glued to the torn line');
    assert.equal(loaded.settled.size, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('journal: valid-JSON non-object lines (null, 42) are skipped, not fatal', () => {
  const dir = tmp();
  try {
    const j = Journal.create(dir, { runId: 'r', script: 's.mjs', harness: 'echo' });
    appendFileSync(j.path, 'null\n42\n"str"\n');
    j.append({ type: 'agent', i: 0, label: 'a', ok: true, result: { text: 'x' } });
    assert.equal(Journal.load(j.path).settled.size, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extractJson: stray braces in prose before the real object do not hide it', () => {
  assert.deepEqual(extractJson('Using {curly} braces first. Result: {"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Set {x} then ```{"b":2}``` done'), { b: 2 });
});

test('spawnProcess: multi-byte characters split across stdout chunks survive intact', async () => {
  const code = `const b=Buffer.from('€ héllo 日本');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),50);`;
  const r = await spawnProcess([process.execPath, '-e', code], {});
  assert.equal(r.stdout, '€ héllo 日本');
});

function cli(args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('cli: boolean flags before the script path do not swallow it', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'w.mjs'), `log('ran')`);
    for (const flag of ['--allow-nondeterminism', '--cache']) {
      const r = await cli(['run', flag, 'w.mjs', '--harness', 'echo'], dir);
      assert.equal(r.code, 0, `${flag}: ${r.out}`);
      assert.match(r.out, /ran/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cli: non-numeric --concurrency is rejected with a clear message', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'w.mjs'), `log('ran')`);
    const r = await cli(['run', 'w.mjs', '--harness', 'echo', '--concurrency', 'abc'], dir);
    assert.equal(r.code, 2);
    assert.match(r.out, /--concurrency.*abc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runtime: a script that throws aborts its still-running agent calls', async () => {
  const dir = tmp();
  try {
    let aborted = null;
    const adapter = {
      name: 'hang',
      async spawnAgent(spec) {
        await new Promise((r) => { spec.signal.addEventListener('abort', r, { once: true }); setTimeout(r, 3000).unref(); });
        aborted = spec.signal.aborted;
        return { ok: false, error: { message: 'killed' } };
      },
    };
    writeFileSync(join(dir, 'w.mjs'), `agent('slow', {label:'s'}); await new Promise(r => setTimeout(r, 50)); throw new Error('boom');`);
    const res = await runScript({ scriptPath: join(dir, 'w.mjs'), adapter, cwd: dir, err: () => {} });
    assert.equal(res.code, 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(aborted, true, 'in-flight agent was left running after the script failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SIGINT twice: second Ctrl-C force-aborts instead of waiting out the grace window', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'w.mjs'), `log('boot'); await agent('x', {label:'a'});`);
    const child = spawn(process.execPath, [BIN, 'run', 'w.mjs', '--harness', 'echo', '--grace', '20000'], { cwd: dir, env: { ...process.env, AGENTFLOW_ECHO_SLOW: '30000' } });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    await new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => { if (err.includes('boot')) { clearInterval(iv); res(); } else if (Date.now() - t0 > 15000) { clearInterval(iv); rej(new Error('no boot')); } }, 20);
    });
    await new Promise((r) => setTimeout(r, 150));
    child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 300));
    const t = Date.now();
    child.kill('SIGINT');
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 130);
    assert.ok(Date.now() - t < 3000, `took ${Date.now() - t}ms`);
    const loaded = Journal.load(Journal.pathFor(dir, Journal.list(dir)[0].runId));
    assert.equal(loaded.ended?.reason, 'interrupted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extractJson: a balanced-but-invalid block is skipped whole, never returning its nested sub-object', () => {
  assert.equal(extractJson('Result: {"a": {"b":1} oops}'), null);
  assert.deepEqual(extractJson('Result: {"a": {"b":1} oops} then {"c":3}'), { c: 3 });
  // unbalanced outer: still recovers a later complete object
  assert.deepEqual(extractJson('{ "a": 1, then {"d":4}'), { d: 4 });
});

test('runtime: a script that returns with un-awaited agent calls aborts the in-flight one and never starts the queued one', async () => {
  const dir = tmp();
  try {
    const started = [];
    let inflightAborted = null;
    const adapter = {
      name: 'hang',
      async spawnAgent(spec) {
        started.push(spec.prompt);
        await new Promise((r) => { spec.signal.addEventListener('abort', r, { once: true }); setTimeout(r, 3000).unref(); });
        inflightAborted = spec.signal.aborted;
        return { ok: false, error: { message: 'killed' } };
      },
    };
    writeFileSync(join(dir, 'w.mjs'), `agent('first', {label:'a'}); agent('second', {label:'b'}); await new Promise(r => setTimeout(r, 50));`);
    const res = await runScript({ scriptPath: join(dir, 'w.mjs'), adapter, concurrency: 1, cwd: dir, err: () => {} });
    assert.equal(res.code, 0);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(inflightAborted, true, 'in-flight call was not aborted');
    assert.deepEqual(started, ['first'], 'queued call should never have started');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cli: numeric flag validation (table)', async () => {
  const cases = [
    { args: ['--retries', '0'], ok: true },
    { args: ['--grace', '0'], ok: true },
    { args: ['--concurrency', '0'], flag: 'concurrency' },
    { args: ['--max-agents', '-1'], flag: 'max-agents' },
    { args: ['--batch-poll', 'x'], flag: 'batch-poll' },
    { args: ['--retries'], flag: 'retries' },
    { config: { concurrency: 0 }, args: [], flag: 'concurrency' },
  ];
  for (const c of cases) {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'w.mjs'), `log('ran')`);
      if (c.config) writeFileSync(join(dir, 'agentflow.json'), JSON.stringify(c.config));
      const r = await cli(['run', 'w.mjs', '--harness', 'echo', ...c.args], dir);
      const label = JSON.stringify(c);
      if (c.ok) assert.equal(r.code, 0, `${label}: ${r.out}`);
      else {
        assert.equal(r.code, 2, `${label}: ${r.out}`);
        assert.match(r.out, new RegExp(`--${c.flag} must be`), label);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
