// Minimal live check: two devin agents in parallel, then a follow-up that
// consumes their results. Costs real tokens — run deliberately:
//   agentflow run examples/devin-smoke.mjs --harness devin
export const meta = { name: 'devin-smoke', description: 'two-agent live smoke test' };

phase('smoke');
const [a, b] = await parallel([
  () => agent('Reply with exactly: ALPHA', { label: 'smoke-a', model: 'devin-lite' }),
  () => agent('Reply with exactly: BRAVO', { label: 'smoke-b', model: 'devin-lite' }),
]);
log(`a=${a?.text ?? 'null'} b=${b?.text ?? 'null'}`);

if (a && b) {
  const check = await agent(`One agent said "${a.text.trim()}" and another said "${b.text.trim()}". Reply OK if those are ALPHA and BRAVO.`, { label: 'verify' });
  log(`verify: ${check?.text ?? 'null'}`);
}
