import { readFileSync, existsSync } from 'node:fs';

// Live run view: fold a run journal's event stream into per-index state and
// render it as a fixed-size ANSI frame. Pure functions — cli.mjs owns the
// alternate screen + tick loop; tests drive fold/render directly.
//
// State derivation is always from the full event stream (KTD4): the latest
// record per index wins — in-flight -> agent (settled), batch -> batch-poll
// -> per-item agent records. Indices with an in-flight record but no agent
// record when run-end lands are 'abandoned'.

export function readJournal(path) {
  if (!existsSync(path)) return null;
  const records = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return records;
}

export function foldState(records) {
  // A resume appends a new epoch to the same durable journal. The interactive
  // view renders only that epoch; Journal.load still retains earlier settled
  // calls so runtime replay remains unchanged.
  const start = (records ?? []).map((rec) => rec.type).lastIndexOf('run-start');
  const epoch = start === -1 ? (records ?? []) : records.slice(start);
  const state = { meta: null, lanes: new Map(), batches: new Map(), phases: [], done: null };
  // phaseName is the phase the NEXT record belongs to. Lanes keep the phase
  // that was active when they appeared (an un-awaited agent can outlive its
  // phase); the agent record preserves the in-flight lane's stamp.
  let phaseName = null;
  for (const rec of epoch) {
    if (rec.type === 'run-start') { state.meta = rec; phaseName = null; }
    else if (rec.type === 'phase') {
      phaseName = String(rec.name ?? '');
      state.phases.push({ name: phaseName, at: rec.at ?? null, nextI: rec.nextI ?? null });
    } else if (rec.type === 'in-flight') {
      state.lanes.set(rec.i, { i: rec.i, label: rec.label, model: rec.model, batch: rec.batch ?? null, state: 'in-flight', at: rec.at, phase: phaseName });
    } else if (rec.type === 'agent') {
      const prior = state.lanes.get(rec.i);
      state.lanes.set(rec.i, {
        i: rec.i, label: rec.label, model: rec.model,
        state: rec.ok ? 'ok' : 'fail', at: rec.at, elapsed: rec.elapsed,
        batch: prior?.batch ?? null,
        phase: prior?.phase ?? phaseName,
        error: rec.ok ? null : (rec.error?.message ?? 'failed'),
        usage: rec.result?.usage ?? rec.error?.usage ?? null,
        summary: rec.ok ? firstLine(rec.result?.text) : null,
      });
    } else if (rec.type === 'batch') {
      state.batches.set(rec.batch_id, { id: rec.batch_id, firstI: rec.firstI, count: rec.count, model: rec.model, status: 'submitted', poll: null, phase: phaseName });
    } else if (rec.type === 'batch-poll') {
      const b = state.batches.get(rec.batch_id) ?? { id: rec.batch_id, firstI: null, count: rec.total ?? null, model: null, poll: null, phase: null };
      b.status = rec.status;
      b.poll = rec;
      state.batches.set(rec.batch_id, b);
    } else if (rec.type === 'run-end') {
      state.done = rec;
      for (const lane of state.lanes.values()) {
        if (lane.state === 'in-flight') lane.state = 'abandoned';
      }
    }
  }
  return state;
}

// The lane's "what it found" line: first non-empty line of result text,
// heading marks stripped, cut at the first sentence boundary when one is
// near enough that a reader still gets the gist.
const firstLine = (text) => {
  if (typeof text !== 'string') return null;
  const raw = text.split('\n').map((l) => l.trim()).find(Boolean);
  if (!raw) return null;
  const s = raw.replace(/^#{1,6}\s+/, '');
  const cut = s.indexOf('. ');
  return cut > 0 && cut < 160 ? s.slice(0, cut + 1) : s;
};

const SPIN = ['◐', '◓', '◑', '◒'];
// DESIGN.md glyphs: status is glyph + word, never colour alone.
const ICON = { ok: '✓', fail: '✗', abandoned: '◌' };
const PHASE_ICON = { done: '✓', active: '▶', pending: '◇' };
// DESIGN.md dark-canvas tokens (truecolor). Applied only when `color` is on;
// monochrome terminals get identical text with zero escapes.
const COL = { teal: [79, 209, 197], green: [95, 208, 138], red: [255, 138, 128], amber: [242, 184, 75], muted: [154, 164, 178] };

const trunc = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, Math.max(1, n - 1)) + '…' : String(s ?? ''));
// Width cut that skips ANSI escapes — trunc() counts bytes, this counts
// visible cells, so a coloured line is never sliced mid-escape.
const cut = (s, n) => {
  if (!s.includes('\x1b')) return s.slice(0, n);
  let out = '', vis = 0, i = 0;
  while (i < s.length && vis < n) {
    const esc = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (esc) { out += esc[0]; i += esc[0].length; continue; }
    out += s[i++]; vis++;
  }
  return i < s.length ? out + '\x1b[0m' : out;
};

const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const fmtTok = (n) => (n == null ? '?' : n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
// '37k/41' = prompt/completion tokens for one call or the run total.
const tokPair = (u) => (u ? ` ${fmtTok(u.promptTokens)}/${fmtTok(u.completionTokens)}` : '');

const fmtSecs = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
};

// Big-ASCII finale card — 5-row block font for the run's spend figure.
// Charset covers what totals render as: digits, '.', '$', 'k', 'M', space.
const GLYPH = {
  '0': ['█████', '█   █', '█   █', '█   █', '█████'],
  '1': ['  █  ', ' ██  ', '  █  ', '  █  ', '█████'],
  '2': ['█████', '    █', '█████', '█    ', '█████'],
  '3': ['█████', '    █', ' ████', '    █', '█████'],
  '4': ['█   █', '█   █', '█████', '    █', '    █'],
  '5': ['█████', '█    ', '█████', '    █', '█████'],
  '6': ['█████', '█    ', '█████', '█   █', '█████'],
  '7': ['█████', '    █', '   █ ', '  █  ', '  █  '],
  '8': ['█████', '█   █', '█████', '█   █', '█████'],
  '9': ['█████', '█   █', '█████', '    █', '█████'],
  '.': ['     ', '     ', '     ', '     ', '  █  '],
  '$': [' ████', '█ █  ', ' ███ ', '  █ █', '████ '],
  'k': ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
  'M': ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  ' ': ['     ', '     ', '     ', '     ', '     '],
};

export function bigNumber(str) {
  const chars = [...str].map((c) => GLYPH[c] ?? GLYPH[' ']);
  return [0, 1, 2, 3, 4].map((r) => chars.map((g) => g[r]).join(' ')).join('\n');
}

const progressBar = (done, total, seg = 24) => {
  const fill = total ? Math.round((done / total) * seg) : 0;
  return `${'█'.repeat(fill)}${'░'.repeat(seg - fill)}`;
};

// One frame of the watch view. `tick` rotates the in-flight spinner;
// `now`/`runStart.at` derive ages deterministically for tests.
export function renderFrame(state, { now = Date.now(), width = 100, tick = 0, pidAlive = null, color = false } = {}) {
  const w = Math.max(40, width);
  const lines = [];
  const meta = state.meta ?? {};
  const started = meta.at ? Date.parse(meta.at) : now;
  const lanes = [...state.lanes.values()].sort((a, b) => a.i - b.i);
  const nOk = lanes.filter((l) => l.state === 'ok').length;
  const nFail = lanes.filter((l) => l.state === 'fail').length;
  const nFlight = lanes.filter((l) => l.state === 'in-flight').length;
  const nAbandoned = lanes.filter((l) => l.state === 'abandoned').length;
  const settled = nOk + nFail + nAbandoned;
  const spin = SPIN[tick % SPIN.length];
  const P = (rgb, s) => (color && s ? `\x1b[38;2;${rgb.join(';')}m${s}\x1b[0m` : s);

  // Title: the workflow's own name — a reader cares what the run IS, not its
  // id. Run-id is demoted to the footer.
  const models = [...new Set(lanes.map((l) => l.model).filter(Boolean))];
  const modelStr = models.length ? ` · ${models.slice(0, 3).join(',')}${models.length > 3 ? ',…' : ''}` : '';
  lines.push(P(COL.teal, `${meta.name ?? meta.script ?? '?'} · ${meta.harness ?? '?'}${modelStr}`));

  // Header: progress + "N of ~M steps" (M is calls seen so far — scripts are
  // dynamic, the total is always an estimate) + elapsed + liveness.
  const bar = progressBar(settled, lanes.length, Math.min(20, Math.max(8, Math.floor(w / 4))));
  const alive = state.done ? `ended ${state.done.reason}` : (pidAlive === false ? 'pid gone — orphaned?' : (meta.pid ? `pid ${meta.pid}` : 'running'));
  lines.push(`${bar} ${settled} of ~${lanes.length} steps · ${fmtSecs(now - started)} · ${alive}`);

  const labW = Math.floor(w * 0.42);
  const laneRow = (l) => {
    const model = l.model ? ` (${l.model})` : '';
    const label = trunc(`[${l.i}] ${l.label ?? ''}${model}`, labW).padEnd(labW);
    if (l.state === 'in-flight') {
      const age = l.at ? ` ${fmtSecs(now - Date.parse(l.at))}` : '';
      return `  ${P(COL.teal, spin)} ${label} ${P(COL.teal, 'running')}${age}`;
    }
    if (l.state === 'ok') return `  ${P(COL.green, ICON.ok)} ${label} ${P(COL.green, 'ok')} ${l.elapsed ?? ''}s${tokPair(l.usage)}`;
    if (l.state === 'fail') return `  ${P(COL.red, ICON.fail)} ${label} ${P(COL.red, 'fail')} ${l.elapsed ?? ''}s${tokPair(l.usage)}  ${P(COL.red, trunc(l.error, Math.floor(w * 0.3)))}`;
    return `  ${P(COL.amber, ICON.abandoned)} ${label} ${P(COL.amber, 'abandoned')}`;
  };
  const findRow = (l) => (l.state === 'ok' && l.summary ? `    ${P(COL.muted, trunc(l.summary, Math.min(90, w - 6)))}` : null);
  const batchRow = (b) => {
    const counts = b.poll?.total != null ? `  ${b.poll.settled ?? '?'}/${b.poll.total} settled` : '';
    const pollAt = b.poll?.at ? `  last poll ${fmtSecs(now - Date.parse(b.poll.at))} ago` : '';
    return `  ${P(COL.teal, '▶')} batch${b.count != null ? `[${b.count}]` : ''} ${trunc(b.id, 28)}  ${b.status}${counts}${pollAt}`;
  };

  // Group lanes under phases. Order = declared meta.phases first, then
  // phase records the script never declared — groups are then positioned by
  // the call index where the phase began, so un-phased lanes (a lone agent()
  // before/between phase() calls) sort into their real place instead of
  // clumping at one end. Pending declared phases (no record yet) sink last.
  const declared = Array.isArray(meta.phases) ? meta.phases.filter((p) => typeof p === 'string') : [];
  const order = [];
  for (const n of declared) if (!order.includes(n)) order.push(n);
  for (const p of state.phases) if (!order.includes(p.name)) order.push(p.name);
  const groups = order.map((name) => ({
    name,
    rec: state.phases.find((p) => p.name === name) ?? null,
    lanes: lanes.filter((l) => l.phase === name),
    batches: [...state.batches.values()].filter((b) => b.phase === name),
  }));
  const seq = [
    ...groups.map((g) => ({ kind: 'group', g, pos: g.rec?.nextI ?? Math.min(Infinity, ...g.lanes.map((l) => l.i)) })),
    ...lanes.filter((l) => l.phase == null).map((l) => ({ kind: 'lane', l, pos: l.i })),
    ...[...state.batches.values()].filter((b) => b.phase == null).map((b) => ({ kind: 'batch', b, pos: b.firstI ?? Infinity })),
  ].sort((a, b) => a.pos - b.pos);

  for (const item of seq) {
    if (item.kind === 'lane') {
      lines.push(laneRow(item.l));
      const f = findRow(item.l);
      if (f) lines.push(f);
      continue;
    }
    if (item.kind === 'batch') { lines.push(batchRow(item.b)); continue; }
    const g = item.g;
    const gSettled = g.lanes.filter((l) => l.state !== 'in-flight').length;
    const gFail = g.lanes.filter((l) => l.state === 'fail').length;
    const gRunning = g.lanes.some((l) => l.state === 'in-flight');
    const glyph = !g.rec ? PHASE_ICON.pending : (gRunning || (!g.lanes.length && !state.done)) ? PHASE_ICON.active : PHASE_ICON.done;
    const c = !g.rec ? COL.amber : glyph === PHASE_ICON.active ? COL.teal : COL.green;
    const status = !g.rec
      ? (state.done ? 'not reached' : 'upcoming')
      : (g.lanes.length ? `${gSettled}/${g.lanes.length}${gFail ? ` · ${gFail} failed` : ''}` : (state.done ? 'no calls' : 'in progress'));
    lines.push(`${P(c, `${glyph} ${trunc(g.name, Math.floor(w * 0.5))}`)} ${P(COL.muted, `— ${status}`)}`);
    for (const l of g.lanes) {
      lines.push(laneRow(l));
      const f = findRow(l);
      if (f) lines.push(f);
    }
    for (const b of g.batches) lines.push(batchRow(b));
  }

  const tot = lanes.reduce((a, l) => (l.usage
    ? { p: a.p + (l.usage.promptTokens ?? 0), c: a.c + (l.usage.completionTokens ?? 0), k: a.k + (l.usage.cachedTokens ?? 0), usd: a.usd + (l.usage.costUsd ?? 0), usdSeen: a.usdSeen || l.usage.costUsd != null, n: a.n + 1 }
    : a), { p: 0, c: 0, k: 0, usd: 0, usdSeen: false, n: 0 });
  const tokTotal = (tot.p || tot.c || tot.k) ? ` · ${P(COL.muted, `tokens ${fmtTok(tot.p)}/${fmtTok(tot.c)}${tot.k ? ` (+${fmtTok(tot.k)} cached)` : ''}`)}` : '';
  const runTag = meta.runId ? ` · ${P(COL.muted, `run ${meta.runId}`)}` : '';

  // Counts read as a sentence ("4 ok · 0 failed"), matching the frame's own
  // '·' separators. The run-id rides last and is dropped whole rather than
  // sliced mid-token — a partial id can't be resumed from anyway.
  const counts = `${nOk} ok · ${nFail} failed · ${state.done ? `${nAbandoned} abandoned` : `${nFlight} running`}`;
  const footer = `${state.done ? `${P(COL.muted, `run ${state.done.reason}`)} — ` : ''}${counts}${tokTotal}`;
  lines.push(visLen(footer + runTag) <= w ? footer + runTag : footer);

  if (state.done) {
    // The payoff: total spend, large. costUsd wins when a harness reports
    // dollars (claude); tokens are the spend proxy everywhere else. usdSeen
    // not usd — a genuinely free $0.00 run still gets the dollar card.
    if (tot.usdSeen) {
      lines.push('', ...bigNumber(`$${tot.usd.toFixed(2)}`).split('\n'), '     total spend');
    } else if (tot.n) {
      lines.push('', ...bigNumber(fmtTok(tot.p + tot.c)).split('\n'), '     total tokens (in+out)');
    }
  }
  return lines.map((l) => cut(l, w)).join('\n') + '\n';
}
