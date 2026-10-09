import { spawnAgent as run, extractJson, probeBinary, withSchemaPrompt } from './base.mjs';

// Verified against `devin --help` (3000.11.3):
//   -p/--print [PROMPT], --permission-mode auto|accept-edits|smart|dangerous,
//   --model, --sandbox, --respect-workspace-trust false (required headless in
//   untrusted dirs), --export, --cloud.
// KTD7: default 'smart' (auto-runs actions a fast model judges safe);
// 'escalated' -> 'dangerous'. 'auto' alone is read-only — too weak for coding.
const PERMISSION_MAP = { escalated: 'dangerous', smart: 'smart', auto: 'auto', 'accept-edits': 'accept-edits', dangerous: 'dangerous' };

export default {
  name: 'devin',
  bin: 'devin',
  requiredFlags: ['--print', '--permission-mode', '--model', '--respect-workspace-trust'],
  permissionDeniedPatterns: [
    /permission (denied|required)/i,
    /approval (required|denied)/i,
    /requires approval/i,
    /workspace trust/i,
    /untrusted (directory|workspace)/i,
  ],

  buildArgv(spec) {
    const argv = [this.bin, '-p', spec.prompt, '--respect-workspace-trust', 'false', '--permission-mode', PERMISSION_MAP[spec.permission] ?? 'smart'];
    if (spec.model) argv.push('--model', spec.model);
    if (spec.sandbox) argv.push('--sandbox');
    return argv;
  },

  // No native structured-output flag: enforce schema via prompt, extract after.
  async spawnAgent(spec) {
    return run(this, withSchemaPrompt(spec));
  },

  parse(r, spec) {
    const text = (r.stdout ?? '').trim();
    if (!text) return null;
    return { text, json: spec.schema ? extractJson(text) : null };
  },

  probe() { return probeBinary(this); },
};
