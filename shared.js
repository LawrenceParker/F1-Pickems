/* shared.js — data loading, scoring, pick order and achievements. Used by every page. */

// ---------- Settings ----------
const API = 'https://api.jolpi.ca/ergast/f1';
const CACHE_PREFIX = 'f1pickems2:';
// How the next pick order is ranked: 'last_round' (points from the latest race) or 'overall' (season total)
const PICK_ORDER_BASIS = 'last_round';
const FILES = {
  picks: 'picks.csv',
  scoring: 'scoring.csv',
  table: 'points_table.csv',
  achievements: 'achievements.csv'
};
// Sessions the page knows how to fetch. Adding one means adding its API path and result key here.
const SESSIONS = {
  qualifying: { path: 'qualifying', key: 'QualifyingResults', label: 'Quali', order: 0 },
  sprint:     { path: 'sprint',     key: 'SprintResults',     label: 'Sprint', order: 1 },
  race:       { path: 'results',    key: 'Results',           label: 'Race', order: 2 }
};

// ---------- Achievement conditions ----------
// To add a new kind of achievement, add one line here, then use its name in the "condition" column of achievements.csv.
// c = one player's result for one session: { pts, position, dnf, laps, slotMax }. t = the "threshold" column.
const ROUND_CONDITIONS = {
  picked_winner:   c => c.position === 1,
  picked_podium:   c => c.position >= 1 && c.position <= 3,
  picked_dnf:      c => c.dnf === true,
  zero_points:     c => c.pts === 0,
  points_at_least: (c, t) => c.pts >= t,
  points_at_most:  (c, t) => c.pts <= t,
  top_scorer:      c => c.pts > 0 && c.pts === c.slotMax
};
// Season-wide conditions return the label of the session where it was reached, or null.
const SEASON_CONDITIONS = {
  total_points_at_least: (player, t, model) => {
    for (const s of model.slots) if (s.done && model.cum[player][s.key] >= t) return s.label;
    return null;
  }
};

// ---------- Helpers ----------
const $ = id => document.getElementById(id);
const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isYes = v => /^(yes|true|1|y)$/i.test(String(v || '').trim());
const playerColor = i => `hsl(${Math.round((i * 137.5) % 360)} 60% 50%)`;

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

async function loadCSV(path, optional = false) {
  const res = await fetch(path + '?t=' + Date.now());
  if (!res.ok) {
    if (optional) return [];
    throw new Error(path + ' returned ' + res.status);
  }
  return parseCSV(await res.text());
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ' returned ' + res.status);
  return res.json();
}

async function loadData(extraFiles = []) {
  const [picks, scoring, table] = await Promise.all([
    loadCSV(FILES.picks), loadCSV(FILES.scoring), loadCSV(FILES.table, true)
  ]);
  const data = {
    picks: picks
      .filter(p => p.season && p.round && p.player && p.driver && !isNaN(Number(p.round)))
      .map(p => ({ ...p, round: String(Number(p.round)), session: (p.session || 'race').toLowerCase() })),
    scoring, table
  };
  for (const name of extraFiles) data[name] = await loadCSV(FILES[name], true);
  return data;
}

// ---------- Season picker and status ----------
function initSeasonSelect(picks, onChange) {
  const seasons = [...new Set(picks.map(p => p.season))].sort().reverse();
  if (!seasons.length) { $('sub').textContent = 'No picks found in ' + FILES.picks + '.'; return; }
  if (seasons.length > 1) {
    $('bar').hidden = false;
    $('season').innerHTML = seasons.map(s => `<option>${esc(s)}</option>`).join('');
    $('season').onchange = e => onChange(e.target.value);
  }
  onChange(seasons[0]);
}

function setStatus(msg, isError) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', !!isError);
}

function showFatal(e) {
  $('sub').textContent = 'Could not load the page data.';
  setStatus(e.message + '. If you opened this file directly, serve it from a web server or GitHub Pages instead.', true);
}

// ---------- Fetching session results ----------
function withIndex(o, cached) {
  const index = new Map();
  o.entries.forEach(e => e.keys.forEach(k => index.set(k, e)));
  return { race: o.race, entries: o.entries, index, cached };
}

async function loadSession(season, round, session) {
  const info = SESSIONS[session];
  if (!info) throw new Error('Unknown session "' + session + '" in ' + FILES.picks + ' (use race, sprint or qualifying).');
  const key = CACHE_PREFIX + season + ':' + round + ':' + session;
  try { const hit = localStorage.getItem(key); if (hit) return withIndex(JSON.parse(hit), true); } catch (e) {}

  const data = await getJSON(`${API}/${season}/${round}/${info.path}.json`);
  const race = data.MRData.RaceTable.Races[0];
  const list = race && race[info.key];
  if (!list || !list.length) return { pending: true };

  const entries = list.map(r => {
    const d = r.Driver, status = r.status || '';
    const finished = status === 'Finished' || /^\+\d+ Laps?$/.test(status) || status === 'Lapped';
    return {
      keys: [d.code, d.driverId, d.familyName, d.givenName + d.familyName, d.permanentNumber].filter(Boolean).map(norm),
      position: Number(r.position),
      points: Number(r.points) || 0,
      laps: Number(r.laps) || 0,
      dnf: !!status && !finished
    };
  });
  const out = { race: race.raceName, entries };
  try { localStorage.setItem(key, JSON.stringify(out)); } catch (e) {}
  return withIndex(out, false);
}

// ---------- Scoring model ----------
function computeModel(season, data, results) {
  const picks = data.picks.filter(p => p.season === season);

  const slotMap = new Map();
  picks.forEach(p => {
    const key = p.round + ':' + p.session;
    if (!slotMap.has(key)) slotMap.set(key, { key, round: Number(p.round), session: p.session });
  });
  const slots = [...slotMap.values()].sort((a, b) =>
    a.round - b.round || ((SESSIONS[a.session] || { order: 9 }).order - (SESSIONS[b.session] || { order: 9 }).order));

  const rules = new Map(data.scoring.map(r => [(r.session || '').toLowerCase(), r]));
  const table = new Map();
  data.table.forEach(r => {
    const s = (r.session || '').toLowerCase();
    if (!table.has(s)) table.set(s, new Map());
    table.get(s).set(Number(r.position), Number(r.points) || 0);
  });

  const warnings = new Set();
  slots.forEach(s => {
    const res = results[s.key];
    s.done = !!(res && !res.pending);
    s.race = (res && res.race) || '';
    s.label = 'R' + s.round + (s.session === 'race' ? '' : ' ' + ((SESSIONS[s.session] || {}).label || s.session));
    if (s.done) {
      const rule = rules.get(s.session);
      if (!rule) warnings.add(`No scoring rule for "${s.session}" in ${FILES.scoring}.`);
      else if ((rule.source || '').toLowerCase() === 'table' && !table.has(s.session))
        warnings.add(`"${s.session}" uses a points table but ${FILES.table} has no rows for it.`);
    }
  });

  const players = [...new Set(picks.map(p => p.player))];
  const cells = {};
  players.forEach(pl => cells[pl] = {});

  picks.forEach(p => {
    const key = p.round + ':' + p.session;
    const res = results[key];
    let cell;
    if (!res || res.pending) {
      cell = { driver: p.driver, state: 'pending', pts: 0 };
    } else {
      const e = res.index.get(norm(p.driver));
      const rule = rules.get(p.session);
      if (!e) cell = { driver: p.driver, state: 'missing', pts: 0 };
      else if (!rule) cell = { driver: p.driver, state: 'noscoring', pts: 0 };
      else {
        let pts = (rule.source || '').toLowerCase() === 'table'
          ? ((table.get(p.session) || new Map()).get(e.position) || 0)
          : e.points;
        if (e.position === 1 && isYes(rule.winner_zero)) pts = 0;
        cell = { driver: p.driver, state: 'ok', pts, position: e.position, dnf: e.dnf, laps: e.laps };
      }
    }
    cell.settled = cell.state === 'ok' || cell.state === 'missing';
    cells[p.player][key] = cell;
  });

  slots.forEach(s => {
    const vals = players.map(pl => cells[pl][s.key]).filter(c => c && c.settled).map(c => c.pts);
    const max = vals.length ? Math.max(...vals) : 0;
    players.forEach(pl => { const c = cells[pl][s.key]; if (c) c.slotMax = max; });
  });

  const cum = {};
  const totals = players.map(player => {
    let run = 0; cum[player] = {};
    slots.forEach(s => {
      const c = cells[player][s.key];
      if (c && c.settled) run += c.pts;
      if (s.done) cum[player][s.key] = run;
    });
    return { player, pts: run };
  }).sort((a, b) => b.pts - a.pts || a.player.localeCompare(b.player));

  let rank = 0, prev = null;
  totals.forEach((t, i) => { if (t.pts !== prev) { rank = i + 1; prev = t.pts; } t.rank = rank; });

  return { season, slots, players, cells, cum, totals, warnings: [...warnings] };
}

// Fetches results one session at a time and re-renders after each. Safe to call again when the season changes.
let runId = 0;
async function runSeason(season, data, render, status) {
  const id = ++runId;
  const results = {};
  let model = computeModel(season, data, results);
  render(model);
  status('Fetching results…');
  let err = null;
  for (const s of model.slots) {
    if (id !== runId) return;
    let fresh = true;
    try { const r = await loadSession(season, s.round, s.session); results[s.key] = r; fresh = !r.cached; }
    catch (e) { err = err || e.message; results[s.key] = { pending: true }; }
    if (id !== runId) return;
    model = computeModel(season, data, results);
    render(model);
    if (fresh) await sleep(250);   // stay under the API's rate limit
  }
  if (id !== runId) return;
  const notes = [...(err ? [err] : []), ...model.warnings];
  status(notes.length ? notes.join(' ') : 'Results from the Jolpica F1 API. Updated ' + new Date().toLocaleString() + '.', notes.length > 0);
}

// ---------- Pick order ----------
// Lowest points picks first. Whoever picked the winner of the latest race picks last.
// If several players tie (e.g. on 0 after DNFs), the driver who retired earliest picks first.
function pickOrder(model) {
  const last = [...model.slots].reverse().find(s => s.session === 'race' && s.done);
  if (!last) return null;
  const rows = model.totals.map(t => {
    const c = model.cells[t.player][last.key] || {};
    return {
      player: t.player, overall: t.pts, roundPts: c.settled ? c.pts : 0,
      winnerPick: c.position === 1, dnf: !!c.dnf, laps: c.laps || 0
    };
  });
  const primary = r => PICK_ORDER_BASIS === 'overall' ? r.overall : r.roundPts;
  rows.sort((a, b) =>
    (a.winnerPick - b.winnerPick) ||
    (primary(a) - primary(b)) ||
    ((a.dnf && b.dnf) ? (a.laps - b.laps) : 0) ||
    (a.overall - b.overall) ||
    a.player.localeCompare(b.player));
  rows.forEach(r => {
    r.note = r.winnerPick ? 'Picked the winner, picks last'
      : r.dnf ? `Driver retired on lap ${r.laps}` : '';
  });
  return { slot: last, nextRound: last.round + 1, rows };
}

// ---------- Achievements ----------
function evaluateAchievements(model, defs) {
  return defs.filter(d => d.name && d.condition).map(def => {
    const cond = def.condition.trim();
    const t = def.threshold === '' || def.threshold === undefined ? undefined : Number(def.threshold);
    const times = Number(def.times) || 1;
    const streak = isYes(def.streak);
    const sess = (def.session || 'race').toLowerCase();
    const holders = [];

    if (SEASON_CONDITIONS[cond]) {
      model.totals.forEach(tot => {
        const at = SEASON_CONDITIONS[cond](tot.player, t, model);
        if (at) holders.push({ player: tot.player, at });
      });
      return { def, holders };
    }
    const test = ROUND_CONDITIONS[cond];
    if (!test) return { def, holders, error: `Unknown condition "${cond}"` };

    model.totals.forEach(tot => {
      let run = 0, count = 0, at = null;
      for (const s of model.slots) {
        if (sess !== 'any' && s.session !== sess) continue;
        const c = model.cells[tot.player][s.key];
        if (!c || !c.settled) continue;
        if (test(c, t)) { run++; count++; } else run = 0;
        if (!at && (streak ? run : count) >= times) at = s.label;
      }
      if (at) holders.push({ player: tot.player, at });
    });
    return { def, holders };
  });
}
