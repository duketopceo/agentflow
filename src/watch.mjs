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
  const state = { meta: null, lanes: new Map(), batches: new Map(), done: null };
  for (const rec of records ?? []) {
    if (rec.type === 'run-start') state.meta = rec;
    else if (rec.type === 'in-flight') {
      state.lanes.set(rec.i, { i: rec.i, label: rec.label, model: rec.model, batch: rec.batch ?? null, state: 'in-flight', at: rec.at });
    } else if (rec.type === 'agent') {
      state.lanes.set(rec.i, {
        i: rec.i, label: rec.label, model: rec.model,
        state: rec.ok ? 'ok' : 'fail', at: rec.at, elapsed: rec.elapsed,
        error: rec.ok ? null : (rec.error?.message ?? 'failed'),
        usage: rec.result?.usage ?? rec.error?.usage ?? null,
      });
    } else if (rec.type === 'batch') {
      state.batches.set(rec.batch_id, { id: rec.batch_id, firstI: rec.firstI, count: rec.count, model: rec.model, status: 'submitted', poll: null });
    } else if (rec.type === 'batch-poll') {
      const b = state.batches.get(rec.batch_id) ?? { id: rec.batch_id, firstI: null, count: rec.total ?? null, model: null, poll: null };
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

const SPIN = ['◐', '◓', '◑', '◒'];
const ICON = { 'in-flight': '◐', ok: '●', fail: '○', abandoned: '◌' };
const trunc = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, Math.max(1, n - 1)) + '…' : String(s ?? ''));

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
  '0': ['#####', '#   #', '#   #', '#   #', '#####'],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '#####'],
  '2': ['#####', '    #', '#####', '#    ', '#####'],
  '3': ['#####', '    #', ' ####', '    #', '#####'],
  '4': ['#   #', '#   #', '#####', '    #', '    #'],
  '5': ['#####', '#    ', '#####', '    #', '#####'],
  '6': ['#####', '#    ', '#####', '#   #', '#####'],
  '7': ['#####', '    #', '   # ', '  #  ', '  #  '],
  '8': ['#####', '#   #', '#####', '#   #', '#####'],
  '9': ['#####', '#   #', '#####', '    #', '#####'],
  '.': ['     ', '     ', '     ', '     ', '  #  '],
  '$': [' ####', '# #  ', ' ### ', '  # #', '#### '],
  'k': ['#   #', '#  # ', '###  ', '#  # ', '#   #'],
  'M': ['#   #', '## ##', '# # #', '#   #', '#   #'],
  ' ': ['     ', '     ', '     ', '     ', '     '],
};

export function bigNumber(str) {
  const chars = [...str].map((c) => GLYPH[c] ?? GLYPH[' ']);
  return [0, 1, 2, 3, 4].map((r) => chars.map((g) => g[r]).join(' ')).join('\n');
}

const progressBar = (done, total, seg = 24) => {
  if (!total) return '';
  const fill = Math.round((done / total) * seg);
  return `${'█'.repeat(fill)}${'░'.repeat(seg - fill)} ${done}/${total}`;
};

// One frame of the watch view. `tick` rotates the in-flight spinner;
// `now`/`runStart.at` derive ages deterministically for tests.
export function renderFrame(state, { now = Date.now(), width = 100, tick = 0, pidAlive = null } = {}) {
  const w = Math.max(40, width);
  const lines = [];
  const meta = state.meta ?? {};
  const started = meta.at ? Date.parse(meta.at) : now;
  const lanes = [...state.lanes.values()].sort((a, b) => a.i - b.i);
  const done = lanes.filter((l) => l.state === 'ok' || l.state === 'fail');
  const nOk = lanes.filter((l) => l.state === 'ok').length;
  const nFail = lanes.filter((l) => l.state === 'fail').length;
  const nFlight = lanes.filter((l) => l.state === 'in-flight').length;
  const spin = SPIN[tick % SPIN.length];

  lines.push(`agentflow — ${meta.runId ?? '?'}`);
  const alive = state.done ? `ended ${state.done.reason}` : (pidAlive === false ? 'pid gone — orphaned?' : (meta.pid ? `pid ${meta.pid}` : 'running'));
  lines.push(`${trunc(meta.script ?? '?', Math.floor(w / 3))} · ${meta.harness ?? '?'} · ${fmtSecs(now - started)} · ${alive}`);
  lines.push(progressBar(done.length, lanes.length, Math.min(24, w - 10)));

  for (const lane of lanes) {
    const tag = `[${lane.i}]`;
    const model = lane.model ? ` (${lane.model})` : '';
    const label = trunc(`${tag} ${lane.label ?? ''}${model}`, Math.floor(w * 0.45));
    if (lane.state === 'in-flight') {
      const age = lane.at ? ` ${fmtSecs(now - Date.parse(lane.at))}` : '';
      lines.push(`${spin} ${label.padEnd(Math.floor(w * 0.45))} running${age}`);
    } else if (lane.state === 'ok') {
      lines.push(`${ICON.ok} ${label.padEnd(Math.floor(w * 0.45))} ok ${lane.elapsed ?? ''}s${tokPair(lane.usage)}`);
    } else if (lane.state === 'fail') {
      lines.push(`${ICON.fail} ${label.padEnd(Math.floor(w * 0.45))} fail ${lane.elapsed ?? ''}s${tokPair(lane.usage)}  ${trunc(lane.error, Math.floor(w * 0.35))}`);
    } else {
      lines.push(`${ICON.abandoned} ${label.padEnd(Math.floor(w * 0.45))} abandoned`);
    }
  }

  for (const b of state.batches.values()) {
    const counts = b.poll?.total != null ? `  ${b.poll.settled ?? '?'}/${b.poll.total} settled` : '';
    const pollAt = b.poll?.at ? `  last poll ${fmtSecs(now - Date.parse(b.poll.at))} ago` : '';
    lines.push(`▶ batch${b.count != null ? `[${b.count}]` : ''} ${trunc(b.id, 28)}  ${b.status}${counts}${pollAt}`);
  }

  const nAbandoned = lanes.filter((l) => l.state === 'abandoned').length;
  const tot = lanes.reduce((a, l) => (l.usage
    ? { p: a.p + (l.usage.promptTokens ?? 0), c: a.c + (l.usage.completionTokens ?? 0), usd: a.usd + (l.usage.costUsd ?? 0), n: a.n + 1 }
    : a), { p: 0, c: 0, usd: 0, n: 0 });
  const tokTotal = tot.n ? `  tok ${fmtTok(tot.p)}/${fmtTok(tot.c)}` : '';

  if (state.done) {
    lines.push(`run ${state.done.reason} — ok ${nOk} failed ${nFail} abandoned ${nAbandoned}${tokTotal}`);
    // The payoff: total spend, large. costUsd wins when a harness reports
    // dollars (claude); tokens are the spend proxy everywhere else.
    if (tot.usd) {
      lines.push('', ...bigNumber(`$${tot.usd.toFixed(2)}`).split('\n'), '     total spend');
    } else if (tot.n) {
      lines.push('', ...bigNumber(fmtTok(tot.p + tot.c)).split('\n'), '     total tokens (in+out)');
    }
  } else {
    lines.push(`settled ${done.length} · ok ${nOk} failed ${nFail} running ${nFlight}${tokTotal}`);
  }
  return lines.map((l) => l.slice(0, w)).join('\n') + '\n';
}
