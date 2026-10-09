import { spawnAgent as run, extractJson, probeBinary, withSchemaPrompt } from './base.mjs';

// Verified against `ori code --help` (OpenRouter's native agent):
//   -p/--prompt, --model <openrouter-slug>, --output text|jsonl,
//   --approvals self-drive|manual, --reasoning-effort, --resume/--session.
// ori's approval surface is binary: 'manual' in headless returns agent
// questions to the caller (everything stalls), so both postures map to
// 'self-drive'. Ori's own runtime applies the OpenRouter credential.
export default {
  name: 'ori',
  bin: 'ori',
  helpArgs: ['code', '--help'],
  requiredFlags: ['--prompt', '--model', '--output', '--approvals'],
  permissionDeniedPatterns: [
    /approval (required|denied)/i,
    /requires approval/i,
    /manual approval/i,
  ],

  buildArgv(spec) {
    const argv = [this.bin, 'code', '--prompt', spec.prompt, '--output', 'text', '--approvals', 'self-drive'];
    if (spec.model) argv.push('--model', spec.model); // OpenRouter slug, e.g. deepseek/deepseek-v3.2
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
