import { spawnAgent as run, extractJson, probeBinary, withSchemaPrompt } from './base.mjs';

// Verified against `hermes --help` (Hermes Agent CLI) and one live `-z` call:
//   -z PROMPT        one-shot, non-interactive run; result is plain text on stdout
//   -m MODEL         model override (provider-qualified, e.g. openrouter/z-ai/glm-4.5-air)
//   --provider NAME  inference provider (openrouter, anthropic, openai, ...)
//   --reasoning LEVEL  reasoning effort
//   --safe-mode      reduced autonomy (KTD7 default for headless batch work)
//   --yolo           full autonomy (KTD7 'escalated')
//   --cli            force CLI (non-TUI) rendering when stdout is a pipe
// No native --output-schema flag: schema enforcement is prompt-level
// (withSchemaPrompt), same as the claude/devin adapters.
export default {
  name: 'hermes',
  bin: 'hermes',
  modelFlag: '-m',
  requiredFlags: ['-z', '-m', '--provider', '--reasoning', '--safe-mode', '--yolo', '--cli'],
  permissionDeniedPatterns: [
    /permission (denied|required)/i,
    /approval (required|denied)/i,
    /requires approval/i,
    /not approved/i,
  ],

  buildArgv(spec) {
    const argv = [this.bin, '--cli', '-z', spec.prompt];
    if (spec.model) argv.push('-m', spec.model);
    if (spec.provider) argv.push('--provider', spec.provider);
    if (spec.reasoningEffort) argv.push('--reasoning', spec.reasoningEffort);
    // KTD7: default 'auto' -> --safe-mode; 'escalated' -> --yolo.
    // Live-verified wrinkle: hermes refuses `--safe-mode` without an explicit
    // --model ("read no profile default: pass --model explicitly"), so the
    // autonomy flag is only emitted when the spec pins a model.
    if (spec.model) argv.push(spec.permission === 'escalated' ? '--yolo' : '--safe-mode');
    return argv;
  },

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
