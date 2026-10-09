import { spawnAgent as run, extractJson, probeBinary } from './base.mjs';

// Verified against `opencode run --help` (opencode 1.x):
//   `opencode run [message..]`, -m/--model provider/model, --agent,
//   --format default|json (JSON events on stdout), --dir, --auto
//   (auto-approve permissions not explicitly denied), --attach.
// KTD7: default = no --auto; 'escalated' -> --auto.
export default {
  name: 'opencode',
  bin: 'opencode',
  helpArgs: ['run', '--help'],
  requiredFlags: ['--format', '--model', '--agent', '--dir', '--auto'],
  permissionDeniedPatterns: [
    /permission (denied|required)/i,
    /approval (required|denied)/i,
    /requires approval/i,
    /denied by (permission|config)/i,
  ],

  buildArgv(spec) {
    const argv = [this.bin, 'run', spec.prompt, '--format', 'json'];
    if (spec.model) argv.push('-m', spec.model);
    if (spec.agentName) argv.push('--agent', spec.agentName);
    if (spec.cwd) argv.push('--dir', spec.cwd);
    if (spec.permission === 'escalated') argv.push('--auto');
    return argv;
  },

  async spawnAgent(spec) {
    const s = spec.schema
      ? { ...spec, prompt: `${spec.prompt}\n\nRespond with only a JSON object matching this schema, no prose:\n${JSON.stringify(spec.schema)}` }
      : spec;
    return run(this, s);
  },

  // --format json emits one JSON event per line; collect text parts in order.
  parse(r, spec) {
    const texts = [];
    for (const line of (r.stdout ?? '').split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const t = ev?.part?.type === 'text' ? ev.part.text
        : ev?.type === 'text' ? (ev.text ?? ev?.part?.text)
        : ev?.type === 'result' ? ev.result
        : null;
      if (typeof t === 'string' && t) texts.push(t);
    }
    const text = texts.join('') || (r.stdout ?? '').trim();
    if (!text) return null;
    return { text, json: spec.schema ? extractJson(text) : null };
  },

  probe() { return probeBinary(this); },
};
