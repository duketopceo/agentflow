// Parallel audit: five reviewers over one repo, results aggregated in-script.
//   bin/agentflow run examples/parallel-audit.mjs --harness echo
//   bin/agentflow run examples/parallel-audit.mjs --harness devin --concurrency 3

export const meta = {
  name: "parallel-audit",
  description: "Fan out five audit lenses in parallel, return structured findings",
};

const LENSES = [
  ["security", "security vulnerabilities, injection, secrets, unsafe eval"],
  ["error-handling", "unhandled rejections, swallowed errors, missing timeouts"],
  ["concurrency", "races, unbounded parallelism, shared mutable state"],
  ["api-surface", "leaky abstractions, unstable contracts, missing validation"],
  ["tests", "untested paths, flaky patterns, missing fixtures"],
];

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: { type: "array", items: { type: "object", properties: { severity: { type: "string" }, file: { type: "string" }, issue: { type: "string" } } } },
    summary: { type: "string" },
  },
};

phase("audit");
const results = await parallel(
  LENSES.map(([lens, desc]) => () =>
    agent(`Audit this repository for ${desc}. Report concrete findings only.`, {
      label: `audit:${lens}`,
      schema: FINDINGS_SCHEMA,
    })
  )
);

const report = {};
LENSES.forEach(([lens], i) => {
  const r = results[i];
  report[lens] = r ? (r.json ?? { summary: r.text }) : { error: "agent call failed" };
});

phase("report");
log(`audit complete: ${results.filter(Boolean).length}/${LENSES.length} lenses returned`);
return report;
