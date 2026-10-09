export const meta = {
  name: 'deep-research',
  description: 'Investigate a question: decompose -> parallel research -> adversarial cross-check -> synthesis.',
  phases: ['decompose', 'research', 'cross-check', 'synthesize'],
};

// Usage: agentflow run workflows/deep-research.mjs --harness devin -- "your question"
// Set AGENTFLOW_CHEAP_MODEL to route bulk stages to a cheaper model
// (e.g. claude-haiku-5-5-low on devin, a provider/model pair on opencode).
const question = args.join(' ').trim();
if (!question) {
  log('usage: agentflow run workflows/deep-research.mjs -- "question"');
  process.exit(2);
}
const CHEAP = process.env.AGENTFLOW_CHEAP_MODEL || undefined;

phase('decompose');
const plan = await agent(
  `Decompose this research question into 4-6 independent sub-questions that can each be researched separately. Reply with ONLY a JSON array of strings.\n\nQuestion: ${question}`,
  { label: 'decompose', model: CHEAP, schema: { type: 'array', items: { type: 'string' } } }
);
const parsed = plan?.json ?? plan?.text?.match(/"[^"]+"/g)?.map((s) => s.slice(1, -1));
const subquestions = Array.isArray(parsed) && parsed.length ? [...parsed] : [];
if (!subquestions.length) {
  log('decompose produced no sub-questions — falling back to the raw question');
  subquestions.push(question);
}
log(`decomposed into ${subquestions.length} sub-questions`);

phase('research');
const findings = await parallel(
  subquestions.map((q) => () =>
    agent(
      `Research this sub-question thoroughly. Report concrete findings with reasoning; flag uncertainty explicitly.\n\nSub-question: ${q}\nParent question: ${question}`,
      { label: `research:${q.slice(0, 40)}` }
    )
  )
);
const pairs = subquestions.map((q, i) => ({ q, finding: findings[i] })).filter((p) => p.finding !== null);
log(`${pairs.length}/${findings.length} researchers returned`);

phase('cross-check');
const checked = await parallel(
  pairs.map((p) => () =>
    agent(
      `Adversarially verify this research finding. Identify unsupported claims, contradictions, or gaps, then return a corrected verdict. If sound, say so concisely.\n\nSub-question: ${p.q}\n\nFinding:\n${p.finding.text}`,
      { label: `verify:${p.q.slice(0, 36)}`, model: CHEAP }
    )
  )
);
const verified = pairs.map((p, i) => ({ q: p.q, verdict: checked[i] })).filter((p) => p.verdict !== null);

phase('synthesize');
const synthesis = await agent(
  `Synthesize a final research report answering the question. Integrate verified findings, note where verifiers corrected researchers, and state residual uncertainty.\n\nQuestion: ${question}\n\nVerified findings:\n${verified.map((p) => `--- ${p.q} ---\n${p.verdict.text}`).join('\n\n')}`,
  { label: 'synthesis' }
);
log('\n' + (synthesis?.text ?? 'synthesis agent failed — inspect .agentflow journal'));
