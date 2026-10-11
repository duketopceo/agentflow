import test from 'node:test';
import assert from 'node:assert/strict';
import { apiKey, resolveRef, OMASEAL_PREFIX } from '../src/keyring.mjs';

// execImpl seam — no real omaseal spawn; each resolveRef test uses a fresh
// ref so the module-level cache can't leak between cases.
let n = 0;
const freshRef = () => `omaseal://test/key-${n++}`;
const okExec = (value) => async () => ({ stdout: `${value}\n` });
const failExec = async () => { throw new Error('store locked'); };

test('apiKey: unset/literal passthrough', async () => {
  assert.equal(await apiKey(undefined), null);
  assert.equal(await apiKey(''), null);
  assert.equal(await apiKey('sk-or-plain'), 'sk-or-plain');
});

test('apiKey: omaseal:// ref resolves via omaseal resolve', async () => {
  const ref = freshRef();
  assert.equal(await apiKey(ref, { execImpl: okExec('resolved-secret') }), 'resolved-secret');
});

test('apiKey: resolution failure returns null (fail closed, not crash)', async () => {
  assert.equal(await apiKey(freshRef(), { execImpl: failExec }), null);
});

test('resolveRef: caches per ref (one spawn for repeated calls)', async () => {
  let calls = 0;
  const counting = async () => { calls++; return { stdout: 'k\n' }; };
  const ref = freshRef();
  await resolveRef(ref, counting);
  await resolveRef(ref, counting);
  assert.equal(calls, 1);
});

test('resolveRef: failure is not memoized (store may unlock later)', async () => {
  const ref = freshRef();
  await assert.rejects(resolveRef(ref, failExec));
  assert.equal(await resolveRef(ref, okExec('later')), 'later');
});
