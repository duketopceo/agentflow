// Fan out a review agent per file, then synthesize. Run with:
//   agentflow run examples/parallel-audit.mjs --harness echo
//   agentflow run examples/parallel-audit.mjs --harness devin -- src/ other/
export const meta = { name: 'parallel-audit', description: 'per-file review fan-out + synthesis' };

const targets = args.length ? args : ['src/', 'tests/'];

phase('collect');
const { readdirSync, statSync } = await import('node:fs');
const { join } = await import('node:path');
const files = targets.flatMap((t) => {
  try {
    return readdirSync(t, { recursive: true })
      .filter((f) => /\.(mjs|js|ts|tsx)$/.test(f))
      .map((f) => join(t, f));
  } catch { return []; }
}).slice(0, 12);
log(`auditing ${files.length} files`);

phase('fan-out');
const reviews = await parallel(files.map((f) => () =>
  agent(`Read ${f} and report defects or smells in one paragraph.`, {
    label: `review:${f}`,
    schema: { type: 'object', properties: { file: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } } }, required: ['issues'] },
  }),
));

const ok = reviews.filter(Boolean);
log(`${ok.length}/${files.length} reviews settled`);

phase('synthesize');
const digest = await agent(
  `Synthesize these review results into the top 5 cross-cutting issues:\n${ok.map((r) => r.text ?? JSON.stringify(r.json)).join('\n---\n')}`,
  { label: 'synthesis' },
);
log(digest?.text ?? 'synthesis failed');
