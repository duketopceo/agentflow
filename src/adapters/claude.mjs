import { spawnAgent as run, extractJson, probeBinary } from './base.mjs';

// Verified against `claude --help` (2.x):
//   -p/--print, --output-format json (single result object with .result),
//   --model, --permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan.
// KTD7: default 'auto'; 'escalated' -> 'bypassPermissions'.
const PERMISSION_MAP = { escalated: 'bypassPermissions', auto: 'auto', acceptEdits: 'acceptEdits', bypassPermissions: 'bypassPermissions', manual: 'manual', plan: 'plan', dontAsk: 'dontAsk' };

export default {
  name: 'claude',
  bin: 'claude',
  requiredFlags: ['--print', '--output-format', '--model', '--permission-mode'],
  permissionDeniedPatterns: [
    /permission (denied|required)/i,
    /approval (required|denied)/i,
    /requires approval/i,
    /not approved/i,
  ],

  buildArgv(spec) {
    const argv = [this.bin, '-p', spec.prompt, '--output-format', 'json', '--permission-mode', PERMISSION_MAP[spec.permission] ?? 'auto'];
    if (spec.model) argv.push('--model', spec.model);
    return argv;
  },

  async spawnAgent(spec) {
    const s = spec.schema
      ? { ...spec, prompt: `${spec.prompt}\n\nRespond with only a JSON object matching this schema, no prose:\n${JSON.stringify(spec.schema)}` }
      : spec;
    return run(this, s);
  },

  parse(r, spec) {
    let text = (r.stdout ?? '').trim();
    const envelope = extractJson(text);
    if (envelope && typeof envelope === 'object' && 'result' in envelope) text = String(envelope.result ?? '');
    if (!text) return null;
    return { text, json: spec.schema ? extractJson(text) : null };
  },

  probe() { return probeBinary(this); },
};
