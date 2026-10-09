// Multi-angle research: investigate a question from several angles in parallel,
// then synthesize — the shape Claude Code's dynamic workflows use for research.
//   bin/agentflow run examples/multi-angle-research.mjs --harness echo -- "your question"
//
// `args` carries everything after `--`; meta.name labels the run banner and
// is readable in-script as the `meta` global.

export const meta = {
  name: "multi-angle-research",
  description: "Parallel research angles + synthesis pass",
};

const question = args[0] ?? "What are the tradeoffs of event sourcing?";

const ANGLES = [
  ["prior-art", `Research existing implementations and case studies for: ${question}`],
  ["risks", `Analyze failure modes and risks for: ${question}`],
  ["alternatives", `Compare alternatives and opposing approaches to: ${question}`],
];

phase("research");
const angles = await parallel(ANGLES.map(([label, prompt]) => () => agent(prompt, { label: `research:${label}` })));

phase("synthesize");
const notes = angles.map((r, i) => `[${ANGLES[i][0]}]\n${r?.text ?? "(angle failed)"}`).join("\n\n");
const synthesis = await agent(`Synthesize these research notes into a decision-ready answer to: ${question}\n\n${notes}`, { label: "synthesis" });

return { question, synthesis: synthesis?.text ?? null, anglesOk: angles.filter(Boolean).length };
