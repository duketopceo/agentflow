// The compound-engineering loop as an executable workflow:
// ce-plan -> ce-work -> ce-code-review -> ce-compound, each a fresh-context
// agent in the same cwd. The spawned harness must have the CE plugin's
// skills (on devin: auto-installed via agentflow's requiredPlugins).
//   agentflow run workflows/compound-loop.mjs --harness devin -- "<task>"
export const meta = {
  name: 'compound-loop',
  description: 'CE plan -> work -> review -> compound as pooled agents',
  phases: ['plan', 'work', 'review', 'compound'],
};

const task = args.join(' ').trim();
if (!task) {
  log('usage: agentflow run workflows/compound-loop.mjs -- "<task description>"');
} else {
  phase('plan');
  const plan = await agent(
    `Run the ce-plan skill on this task: ${task}\n` +
      `When the plan is written, print exactly one line: PLAN_PATH: <repo-relative path>`,
    { label: 'ce-plan' },
  );
  const planPath = plan?.text?.match(/PLAN_PATH:\s*(\S+)/)?.[1];
  log(`plan: ${planPath ?? '(path not reported — downstream stages will locate the newest plan in docs/plans)'}`);

  phase('work');
  const work = await agent(
    `Run ce-work mode:return-to-caller on the plan at ${planPath ?? 'the newest file in docs/plans'}. ` +
      `Implement every unit, keep the suite green, and commit per unit.`,
    { label: 'ce-work' },
  );
  log(`work: ${work ? 'completed' : 'failed — stopping before review'}`);

  if (work) {
    phase('review');
    const review = await agent(
      `Run ce-code-review mode:agent plan:${planPath ?? 'the newest file in docs/plans'} on the current branch diff. ` +
        `Apply eligible findings; report the rest as residuals.`,
      { label: 'ce-code-review' },
    );

    phase('compound');
    if (review) {
      await agent(
        `Run ce-compound mode:non-interactive. If the review or implementation produced durable reasoning ` +
          `the code does not carry, capture it under docs/solutions/; otherwise report "Documentation skipped".`,
        { label: 'ce-compound' },
      );
    }
    log('compound-loop finished');
  }
}
