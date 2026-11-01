// govern() scratch harness — wraps a worker tool call in
// @microsoft/agent-governance-sdk policy evaluation + hash-chain audit.
//
// Shape mirrors the Python `govern(fn, policy="policy.yaml")`: the caller
// hands govern() a callable plus the action/context the policy sees; the
// governor evaluates first, audits always, executes only on allow (or on
// require_approval once an approver grants).

import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PolicyEngine, AuditLogger } from '@microsoft/agent-governance-sdk';

export class GovernanceDenied extends Error {
  constructor(result) {
    super(`governance denied: ${result.reason ?? result.matchedRule ?? result.action}`);
    this.name = 'GovernanceDenied';
    this.result = result;
  }
}

export class ApprovalPending extends Error {
  constructor(pending) {
    super(`approval required from [${pending.approvers.join(', ')}]: ${pending.action}`);
    this.name = 'ApprovalPending';
    this.pending = pending;
  }
}

export function createGovernor({ policyPath, auditPath, agentDid = 'did:agentflow:worker' }) {
  const engine = new PolicyEngine();
  engine.loadYaml(readFileSync(policyPath, 'utf8'));
  const audit = new AuditLogger();
  const pending = new Map(); // id -> {call, result}
  let seq = 0;

  const record = (call, decision) => {
    const entry = audit.log({
      agentId: agentDid,
      action: call.action,
      decision,
      // AuditLogger strips unknown fields — inputs ride in skillAuditMetadata.
      skillAuditMetadata: { context: call.context },
    });
    if (auditPath) appendFileSync(auditPath, JSON.stringify(entry) + '\n');
    return entry;
  };

  const execute = async (call) => {
    record(call, 'executed');
    return call.fn();
  };

  const governor = {
    audit,

    // The interception point. `call` = { action, context, fn }.
    async govern(call) {
      const result = engine.evaluatePolicy(agentDid, { action: call.action, ...call.context });
      record(call, result.action);
      if (!result.allowed && result.action !== 'require_approval') {
        throw new GovernanceDenied(result);
      }
      if (result.action === 'require_approval') {
        const id = `req-${++seq}`;
        pending.set(id, { call, result });
        throw new ApprovalPending({ id, approvers: result.approvers, action: call.action });
      }
      return execute(call);
    },

    // Grant a pending approval: resumes the original call. Returns false on
    // unknown id so a forged grant can't resurrect anything.
    async approve(id) {
      const p = pending.get(id);
      if (!p) return false;
      pending.delete(id);
      record(p.call, 'approved');
      return execute(p.call);
    },

    async reject(id) {
      const p = pending.get(id);
      if (!p) return false;
      pending.delete(id);
      record(p.call, 'rejected');
      return true;
    },

    get pendingCount() { return pending.size; },
  };
  return governor;
}

// Offline verification of an exported (newline-delimited) audit file —
// AuditLogger has no import, so a post-restart check recomputes the chain.
export function verifyAuditFile(path) {
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  let prev = '0'.repeat(64);
  const entries = lines.map((l, i) => {
    const e = JSON.parse(l);
    if (e.previousHash !== prev) throw new Error(`entry ${i}: broken previousHash link`);
    const payload = JSON.stringify({
      timestamp: e.timestamp,
      agentId: e.agentId,
      action: e.action,
      decision: e.decision,
      previousHash: e.previousHash,
      skillAuditMetadata: e.skillAuditMetadata,
    });
    const hash = createHash('sha256').update(payload).digest('hex');
    if (hash !== e.hash) throw new Error(`entry ${i}: hash mismatch (tampered)`);
    prev = e.hash;
    return e;
  });
  return entries;
}
