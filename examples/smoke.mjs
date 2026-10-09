// Generic live smoke: one agent call per harness. Model slug via first arg:
//   agentflow run examples/smoke.mjs --harness ori -- z-ai/glm-5.3-flash
//   agentflow run examples/smoke.mjs --harness devin -- swe-2-lite
export const meta = { name: 'smoke', description: 'single-agent live smoke' };

phase('smoke');
const [model] = args;
const r = await agent('Reply with exactly: PONG', { label: 'smoke', ...(model ? { model } : {}) });
log(`smoke -> ${r?.text?.trim() ?? 'null'}`);
