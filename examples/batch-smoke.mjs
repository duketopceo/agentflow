export const meta = {
  name: 'batch-smoke',
  description: 'OpenRouter Batch API smoke — 3 trivial prompts in one async job',
  phases: ['batch'],
};

// Usage: agentflow run examples/batch-smoke.mjs --harness openrouter
//   --resume <run-id>  re-polls the journaled batch after a mid-poll interrupt
//   -- <model>         override the batch model (default: batch-capable glm)
// Requires OPENROUTER_API_KEY in env.

phase('batch');
const model = args[0] ?? 'z-ai/glm-5.3-flash';

const results = await batch(
  [
    { prompt: 'Reply with exactly: PONG', label: 'ping-1' },
    { prompt: 'Reply with exactly: PONG PONG', label: 'ping-2' },
    { prompt: 'Reply with exactly: PONG PONG PONG', label: 'ping-3' },
  ],
  { model, batchPollMs: 10_000 },
);

const ok = (results ?? []).filter(Boolean).length;
log(`RESULT:${ok}/3 -> ${(results ?? []).map((r) => (r ? JSON.stringify(r.text) : 'null')).join(' | ') || 'cancelled'}`);
