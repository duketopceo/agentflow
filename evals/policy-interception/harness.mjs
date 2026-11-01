// Scenario runner for the govern() evaluation. Exercises the wrapped
// worker tool surface (shell / fs / net) through the policy in policy.yaml
// and prints a PASS/FAIL line per scenario. Exits non-zero on any failure.
//
// Run:  cd evals/policy-interception && npm install && node harness.mjs

import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createGovernor, verifyAuditFile, GovernanceDenied, ApprovalPending } from './govern.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const auditPath = join(here, 'audit.log');
rmSync(auditPath, { force: true });

const gov = createGovernor({ policyPath: join(here, 'policy.yaml'), auditPath });

// --- Representative worker tool surface (the functions govern() wraps) ---
const shellExec = (cmd) => `(ran) ${cmd}`;
const fsWrite = (path, data) => { writeFileSync(path, data); return `(wrote) ${path}`; };
const netFetch = (host) => `(fetched) ${host}`;

// Context predicates the SDK's condition language cannot express itself:
// substring/glob checks are precomputed here and passed in as booleans.
const shellCtx = (cmd) => ({
  tool: 'shell',
  destructive: /\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f|\s)/.test(cmd) && /\s\/|\s~|\.\.|\*/.test(cmd),
  cmd,
});
const netCtx = (host) => ({ tool: 'net', host, host_allowed: ['api.openrouter.ai', 'api.anthropic.com'].includes(host) });
const fsCtx = (path, op, worktree) => ({ tool: 'fs', op, path, outside_worktree: !path.startsWith(worktree) });

const results = [];
const check = (name, cond, extra = '') => { results.push([name, cond]); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); };

// 1. allow → executes
const r1 = await gov.govern({ action: 'shell.exec', context: shellCtx('git status'), fn: () => shellExec('git status') });
check('allow executes', r1 === '(ran) git status');

// 2. deny → GovernanceDenied, no execution
let executed = false;
try {
  await gov.govern({ action: 'shell.exec', context: shellCtx('rm -rf /tmp/x ../..'), fn: () => { executed = true; } });
} catch (e) { check('deny raises GovernanceDenied', e instanceof GovernanceDenied); }
check('deny: no partial execution', executed === false);

// 3. deny egress off allowlist
try {
  await gov.govern({ action: 'net.fetch', context: netCtx('evil.example'), fn: () => netFetch('evil.example') });
} catch (e) { check('deny non-allowlisted host', e instanceof GovernanceDenied); }

// 4. allowlisted egress passes
const r4 = await gov.govern({ action: 'net.fetch', context: netCtx('api.openrouter.ai'), fn: () => netFetch('api.openrouter.ai') });
check('allowlisted host executes', r4 === '(fetched) api.openrouter.ai');

// 5. require_approval → pending → approve → executes
let wrote = false;
let pendingId = null;
try {
  await gov.govern({ action: 'fs.write', context: fsCtx('/etc/agentflow-eval-canary', 'write', '/tmp/wt'), fn: () => { wrote = true; return 'wrote'; } });
} catch (e) {
  if (e instanceof ApprovalPending) pendingId = e.pending.id;
}
check('require_approval surfaces pending, not crash', pendingId !== null && wrote === false);
const r5 = await gov.approve(pendingId);
check('approval grant resumes execution', r5 === 'wrote' && wrote === true);

// 6. reject path
let p2 = null;
try {
  await gov.govern({ action: 'fs.write', context: fsCtx('/root/nope', 'write', '/tmp/wt'), fn: () => { throw new Error('must not run'); } });
} catch (e) { if (e instanceof ApprovalPending) p2 = e.pending.id; }
check('reject clears pending without running', p2 !== null && (await gov.reject(p2)) === true);

// 7. tamper-evident audit: in-memory chain + exported file
check('in-memory chain verifies', gov.audit.verify() === true);
const entries = verifyAuditFile(auditPath);
check('audit survives restart (offline re-verify)', entries.length === gov.audit.length);
check('audit records decision + inputs', entries.every((e) => e.decision && e.skillAuditMetadata?.context));

// 8. tamper detection: flip a decision in a copy of the file
const tampered = join(here, 'audit-tampered.log');
const lines = entries.map((e) => ({ ...e }));
lines[0].decision = 'deny';
writeFileSync(tampered, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
let caught = false;
try { verifyAuditFile(tampered); } catch { caught = true; }
check('tampering detected by hash chain', caught === true);
rmSync(tampered, { force: true });

// 9. bypass test: an UNWRAPPED call to the same function sees no policy.
// This is the documented blind spot — govern() only sees wrapped calls.
const bypass = shellExec('rm -rf /'); // never evaluated, never audited
check('bypass: unwrapped path executes unaudited', bypass === '(ran) rm -rf /' && gov.audit.length === entries.length);

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
