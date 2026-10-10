// Deterministic test adapter — no subprocess. Records specs for assertions.
// Env knobs for failure paths:
//   AGENTFLOW_ECHO_FAIL=<substr>  labels matching fail with a generic error
//   AGENTFLOW_ECHO_DENY=<substr>  labels matching fail as permissionDenied
//   AGENTFLOW_ECHO_SLOW=<ms>      sleep ms before responding (timeout tests)
//   AGENTFLOW_ECHO_FLAKY=<substr> labels matching fail ONCE then succeed (retry tests)
export const calls = [];
const flaked = new Set();

export default {
  name: 'echo',
  bin: null,
  requiredFlags: [],
  permissionDeniedPatterns: [],

  buildArgv() { return []; },

  async spawnAgent(spec) {
    calls.push(spec);
    const slow = Number(process.env.AGENTFLOW_ECHO_SLOW ?? 0);
    if (slow) {
      if (spec.timeout && slow > spec.timeout) {
        await new Promise((r) => setTimeout(r, spec.timeout));
        return { ok: false, error: { message: 'timed out', timedOut: true, permissionDenied: false, stderrTail: '', code: null } };
      }
      await new Promise((r) => setTimeout(r, slow));
      if (spec.signal?.aborted) return { ok: false, error: { message: 'timed out', timedOut: true, permissionDenied: false, stderrTail: '', code: null } };
    }
    const failRe = process.env.AGENTFLOW_ECHO_FAIL;
    if (failRe && spec.label?.includes(failRe)) {
      return { ok: false, error: { message: 'echo: injected failure', stderrTail: '', code: 1, timedOut: false, permissionDenied: false } };
    }
    const flakyRe = process.env.AGENTFLOW_ECHO_FLAKY;
    if (flakyRe && spec.label?.includes(flakyRe) && !flaked.has(spec.label)) {
      flaked.add(spec.label);
      return { ok: false, error: { message: 'echo: injected flake', stderrTail: '', code: 1, timedOut: false, permissionDenied: false } };
    }
    const denyRe = process.env.AGENTFLOW_ECHO_DENY;
    if (denyRe && spec.label?.includes(denyRe)) {
      return { ok: false, error: { message: 'echo: injected permission denial', stderrTail: '', code: 1, timedOut: false, permissionDenied: true } };
    }
    const text = `echo[${spec.label}]: ${String(spec.prompt).slice(0, 80)}`;
    return { ok: true, result: { text, json: spec.schema ? { echo: spec.label } : null } };
  },

  parse() { return null; },

  async probe() {
    return { ok: true, name: 'echo', bin: 'echo', notes: ['in-process test adapter, no binary required'] };
  },
};
