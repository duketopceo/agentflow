// Audit files matching a regex pattern against a criteria string.
// Usage: agentflow run workflows/audit.mjs -- "<pattern>" "<criteria>"
// Example: agentflow run workflows/audit.mjs -- "\\.md$" "check for broken links"
export const meta = {
  name: 'audit',
  description: 'Audit files matching a regex pattern against a criteria string.',
  phases: ['discover', 'audit', 'report'],
};

const { readdirSync, statSync } = await import('node:fs');
const { join } = await import('node:path');

const pattern = args[0];
const criteria = args.slice(1).join(' ').trim();
if (!pattern || !criteria) {
  log('usage: agentflow run workflows/audit.mjs -- "<pattern>" "<criteria>"');
  process.exit(2);
}

function findFiles(cwd, re) {
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (re.test(p.slice(cwd.length + 1).replace(/\\/g, '/'))) out.push(p);
    }
  }
  walk(cwd);
  return out;
}

const re = new RegExp(pattern);
phase('discover');
const files = findFiles(cwd, re);
log(`discovered ${files.length} files matching /${pattern}/`);

phase('audit');
const findings = await parallel(
  files.map((f) => () =>
    agent(
      `Audit this file and report any issues concise and actionable.\n\nCriteria: ${criteria}\n\nFile: ${f}`,
      { label: `audit:${f.split('/').pop().slice(0, 40)}` }
    )
  )
);

phase('report');
const ok = findings.filter(Boolean);
const results = files.map((f, i) => ({ file: f, finding: findings[i]?.text ?? null }));
log(`audited ${files.length} files, ${ok.length} returned findings`);
return { files: files.length, ok: ok.length, results };
