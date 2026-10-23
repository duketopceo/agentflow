export const meta = {
  name: 'watch-v2',
  description: 'Redesign agentflow watch as a phase-grouped, plain-language progress view',
  phases: ['implement', 'verify', 'docs'],
};

// Run from the agentflow repo root:
//   agentflow run workflows/watch-v2.mjs --harness devin --detach

const MODEL = 'swe-2-max';
const UNIT_TIMEOUT = 60 * 60 * 1000;
const OPTS = { model: MODEL, permission: 'escalated' };

const BASE = `You are working in the agentflow repo — a script-driven multi-agent orchestration CLI (node, ESM .mjs, no deps beyond @opencode plugin devDeps). Work only inside the checkout at your cwd, on a new branch \`feat/watch-v2\` (create it first: git checkout -b feat/watch-v2).

Read first: DESIGN.md (the "Run Ledger" direction + color/status tokens — it is the design authority), src/watch.mjs, src/journal.mjs, src/runtime.mjs, src/cli.mjs, tests/watch.test.mjs, and skills/agentflow/SKILL.md.

GOAL — make \`agentflow watch\` a view a NON-TECHNICAL person can follow. Claude Code's /workflows view is the model: each phase shown with its agent counts, drill-able detail showing what each agent FOUND. Ours is a single fixed ANSI frame (no interactivity) so express the same ideas flatly:

Required changes:

1. JOURNAL PHASES. runtime.mjs's phase() currently only writes a stderr line — record {type:'phase', name, at} in the journal too (see journal.mjs append patterns). Resume/older journals without phase records must still fold correctly (one implicit group, no crash). Keep replay/determinism untouched — phase is display metadata only.

2. PHASE-GROUPED FRAME (src/watch.mjs foldState + renderFrame):
   - Title: workflow meta.name (or script basename) + harness · model summary — NOT the run-id (demote run-id to footer).
   - Header: progress bar + "N of ~M steps" (M = calls seen so far; ~ tilde since scripts are dynamic) + elapsed.
   - Phases as group headers in journal order, each "glyph name — done/total" (✓ done, ▶ has running, ◇ pending). Use meta.phases (exported by scripts) to also show upcoming phases with no calls yet.
   - Lane rows under their phase: glyph + label + status + elapsed — ONE result one-liner under ok lanes: the first sentence/line of result.text truncated ~90 chars ("what it found" — the key feature). in-flight lanes show "running M:SS"; waiting lanes show nothing extra.
   - Batch lanes stay supported (unchanged display is fine).
   - Footer: tokens in/out(+cached if present), ok/fail/running counts, run-id. Keep the big-ASCII spend card on run-end — it is good design.
   - Status per DESIGN.md: glyph plus word, never color alone; respect its tokens where color exists.
   - Width-adaptive truncation; pure functions stay pure (all state from records).

3. TESTS (tests/watch.test.mjs): phase records fold into groups; pending phases from meta.phases render; old journals without phases still render; result one-liner truncation; run-end card unchanged. Also update/extend the journal test if phase needs one. node --test must be fully green.

4. \`agentflow tail\` should emit a phase banner line when a phase record passes — one line, same glyph.

Commit atomically as you go. NEVER push, never open PRs. Final message: SUMMARY | FILES | TEST RESULTS | anything left.`;

const must = (r, label) => {
  if (!r) throw new Error(`${label} returned null — inspect journal, then --resume`);
  log(`--- ${label} ---\n${r.text.slice(0, 1500)}`);
  return r;
};

phase('implement');
must(await agent(BASE, { label: 'impl', timeout: UNIT_TIMEOUT, ...OPTS }), 'impl');

phase('verify');
must(
  await agent(
    `You are verifying the watch-v2 redesign in this agentflow checkout (branch feat/watch-v2, already created and committed).

1. git log --oneline -10 to see what landed; read the new src/watch.mjs + tests.
2. node --test — must be fully green. Fix any failure minimally, commit.
3. Functional check WITHOUT a TTY: write a tiny node script that loads a real journal (any .agentflow/runs/*.jsonl in this repo or $HOME/Documents/github/personal/reactor-sim/.agentflow/runs/) via src/watch.mjs's readJournal+foldState+renderFrame and prints a frame at widths 100 and 60. Assert: phases group, a result one-liner appears, pending phases show, no crash on a journal with zero phase records (synthesize one by stripping phase lines). Eyeball the output yourself — does a non-technical reader instantly get where the run is? If not, tighten wording/spacing (this is taste, iterate once or twice), commit.
4. Keep pure functions pure; no new dependencies.

Final message: verdict GREEN/FIXED/BLOCKED + a pasted sample frame.`,
    { label: 'verify', timeout: 45 * 60 * 1000, ...OPTS },
  ),
  'verify',
);

phase('docs');
must(
  await agent(
    `Update docs for the new watch view on branch feat/watch-v2 in this checkout:

- skills/agentflow/SKILL.md "Backgrounded runs" section: describe the phase-grouped view (phases with done/total, per-agent result one-liners, pending phases, metrics footer, spend card). Keep it terse — one short paragraph, no invented flag names.
- README.md watch/status mention if present — same update.
- If a sample frame helps, include a fenced example ≤20 lines matching the actual renderer output (generate it with the test fixtures, don't hand-fake).

node --test must still pass (SKILL.md has no tests but don't break code). Commit. Final message: files touched + whether sample frame is real-rendered.`,
    { label: 'docs', timeout: 30 * 60 * 1000, ...OPTS },
  ),
  'docs',
);

log('watch-v2 done — branch feat/watch-v2 ready for review');
