import { spawnAgent as run, extractJson, probeBinary, withSchemaPrompt } from './base.mjs';

// Verified against `claude --help` (2.x):
//   -p/--print, --output-format json (single result object with .result),
//   --model, --permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan.
// KTD7: default 'auto'; 'escalated' -> 'bypassPermissions'.
const PERMISSION_MAP = { escalated: 'bypassPermissions', auto: 'auto', acceptEdits: 'acceptEdits', bypassPermissions: 'bypassPermissions', manual: 'manual', plan: 'plan', dontAsk: 'dontAsk' };

// Friendly tier names -> real `claude --model` aliases (claude harness only).
// Anything else is passed through literally, so full model ids still work.
export const MODEL_ALIASES = { cheap: 'haiku', default: 'sonnet' };
export const resolveModel = (m) => MODEL_ALIASES[String(m).toLowerCase()] ?? m;

export default {
  name: 'claude',
  bin: 'claude',
  // Only consulted when claude resolves to a Windows .cmd/.bat shim that has
  // to go through cmd.exe: the prompt then travels on stdin (`claude -p` reads
  // it) instead of the command line, so quotes/newlines can't be mangled.
  promptViaStdin: true,
  modelFlag: '--model',
  requiredFlags: ['--print', '--output-format', '--model', '--permission-mode'],
  permissionDeniedPatterns: [
    /permission (denied|required)/i,
    /approval (required|denied)/i,
    /requires approval/i,
    /not approved/i,
  ],

  buildArgv(spec) {
    const argv = [this.bin, '-p', spec.prompt, '--output-format', 'json', '--permission-mode', PERMISSION_MAP[spec.permission] ?? 'auto'];
    if (spec.model) argv.push('--model', resolveModel(spec.model));
    return argv;
  },

  async spawnAgent(spec) {
    return run(this, withSchemaPrompt(spec));
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
