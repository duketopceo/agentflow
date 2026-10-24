// Apply a migration prompt to every file matching a regex, each in its own
// provisioned git worktree so the migration runs in a clean, parallelizable copy.
// Usage: agentflow run workflows/migrate.mjs -- "<pattern>" "<migration prompt>"
// Example: agentflow run workflows/migrate.mjs -- "\\.test\\.mjs$" "convert tests to node --test"
export const meta = {
  name: 'migrate',
  description: 'Apply a migration prompt to files in parallel, each in a fresh git worktree.',
  phases: ['discover', 'migrate', 'report'],
};

const { readdirSync, statSync } = await import('node:fs');
const { join } = await import('node:path');

const pattern = args[0];
const task = args.slice(1).join(' ').trim();
if (!pattern || !task) {
  log('usage: agentflow run workflows/migrate.mjs -- "<pattern>" "<migration prompt>"');
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

phase('migrate');
const results = await parallel(
  files.map((f) => () =>
    agent(
      `Apply this migration to the file. Edit the file in place; explain what you changed.\n\nFile: ${f}\n\nMigration: ${task}`,
      { label: `migrate:${f.split('/').pop().slice(0, 40)}`, worktree: 'auto' }
    )
  )
);

phase('report');
const ok = results.filter(Boolean);
log(`migrated ${ok.length}/${files.length} files`);
return { files: files.length, migrated: ok.length };
