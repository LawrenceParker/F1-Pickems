/* shared.js — data loading, scoring, pick order and achievements. Used by every page. */

// ---------- Settings ----------
const API = 'https://api.jolpi.ca/ergast/f1';
const CACHE_PREFIX = 'f1pickems3:';
// How the next pick order is ranked: 'last_round' (points from the latest race) or 'overall' (season total)
const PICK_ORDER_BASIS = 'last_round';
const FILES = {
  picks: 'picks.csv',
  scoring: 'scoring.csv',
  table: 'points_table.csv',
  teams: 'teams.csv',
  achievements: 'achievements.csv'
};
// Sessions the page knows how to fetch. Adding one means adding its API path and result key here.
const SESSIONS = {
  qualifying: { path: 'qualifying', key: 'QualifyingResults', label: 'Quali', order: 0 },
  sprint:     { path: 'sprint',     key: 'SprintResults',     label: 'Sprint', order: 1 },
  race:       { path: 'results',    key: 'Results',           label: 'Race', order: 2 }
};

// ---------- Achievement conditions ----------
// In achievements.csv the "condition" column can hold one condition or several joined with & (all must be true):
//     picked_driver:VER & points_at_least:10
// Put a session in front to look at another session in the same round:   qualifying.max_points & max_points
// "name:value" passes a value to the condition. With no ":value", the "threshold" column is used instead.
// To add a new kind of condition, add one line to ROUND_CONDITIONS (or SEASON_CONDITIONS) and use its name in the CSV.
//   c = this player's result for the session: { pts, position, dnf, laps, slotMax, maxPts, driver, driverKey, keys, team }
//   a = the value as text (use num(a) for a number)
//   x = { player, slot, model, prev (their previous result in this session type), others (other players' results this session), cellOf(playerName) }
const num = a => (a === '' || a === undefined) ? NaN : Number(a);
const ROUND_CONDITIONS = {
  // the pick's result
  picked_winner:    c => c.position === 1,
  picked_podium:    c => c.position >= 1 && c.position <= 3,
  position_at_most: (c, a) => c.position >= 1 && c.position <= num(a),
  picked_dnf:       c => c.dnf === true,
  // the points
  zero_points:      c => c.pts === 0,
  points_at_least:  (c, a) => c.pts >= num(a),
  points_at_most:   (c, a) => c.pts <= num(a),
  max_points:       c => c.maxPts > 0 && c.pts >= c.maxPts,        // max_points column in scoring.csv
  // which driver or team was picked (driver: code, surname, full name or number; team: constructor id from teams.csv)
  picked_driver:    (c, a) => c.keys.includes(norm(a)),
  picked_team:      (c, a) => c.team === norm(a),
  // compared with the other players
  top_scorer:       c => c.pts > 0 && c.pts === c.slotMax,           // ties count
  sole_top_scorer:  (c, a, x) => c.pts > 0 && x.others.every(o => o.pts < c.pts),
  lowest_scorer:    (c, a, x) => x.others.length > 0 && x.others.every(o => o.pts >= c.pts),
  beat_player:      (c, a, x) => { const o = x.cellOf(a); return !!o && c.pts > o.pts; },
  // compared with their own previous round
  more_than_previous:      (c, a, x) => !!x.prev && c.pts > x.prev.pts,
  less_than_previous:      (c, a, x) => !!x.prev && c.pts < x.prev.pts,
  same_driver_as_previous: (c, a, x) => !!x.prev && !!c.driverKey && c.driverKey === x.prev.driverKey
};
// Season-wide conditions return the label of the session where it was reached, or null. They can't be combined with &.
const SEASON_CONDITIONS = {
  total_points_at_least: (player, a, model) => {
    for (const s of model.slots) if (s.done && model.cum[player][s.key] >= num(a)) return s.label;
    return null;
  },
  unique_drivers_at_least: (player, a, model) => {
    const seen = new Set();
    for (const s of model.slots) {
      const c = model.cells[player][s.key];
      if (c && c.settled && c.driverKey) { seen.add(c.driverKey); if (seen.size >= num(a)) return s.label; }
    }
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
  const res = await fetch(url, { cache: 'no-cache' });   // always revalidate so fresh results show up
  if (!res.ok) throw new Error(url + ' returned ' + res.status);
  return res.json();
}

async function loadData(extraFiles = []) {
  const [picks, scoring, table, teams] = await Promise.all([
    loadCSV(FILES.picks), loadCSV(FILES.scoring), loadCSV(FILES.table, true), loadCSV(FILES.teams, true)
  ]);
  const data = {
    picks: picks
      .filter(p => p.season && p.round && p.player && p.driver && !isNaN(Number(p.round)))
      .map(p => ({ ...p, round: String(Number(p.round)), session: (p.session || 'race').toLowerCase() })),
    scoring, table,
    teams: new Map(teams.filter(t => t.team && t.color).map(t => [norm(t.team), t.color]))
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
      team: norm((r.Constructor || {}).constructorId || ''),
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
      if (!e) cell = { driver: p.driver, state: 'missing', pts: 0, keys: [norm(p.driver)], team: '', driverKey: norm(p.driver) };
      else if (!rule) cell = { driver: p.driver, state: 'noscoring', pts: 0 };
      else {
        let pts = (rule.source || '').toLowerCase() === 'table'
          ? ((table.get(p.session) || new Map()).get(e.position) || 0)
          : e.points;
        if (e.position === 1 && isYes(rule.winner_zero)) pts = 0;
        cell = { driver: p.driver, state: 'ok', pts, position: e.position, dnf: e.dnf, laps: e.laps,
                 color: data.teams.get(e.team) || '', maxPts: Number(rule.max_points) || 0,
                 keys: e.keys, team: e.team, driverKey: e.keys[1] || e.keys[0] || '' };
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
function makeCtx(model, player, slot) {
  const others = model.players.filter(p => p !== player)
    .map(p => model.cells[p][slot.key]).filter(c => c && c.settled);
  let prev = null;
  for (const s of model.slots) {
    if (s.session !== slot.session || s.round >= slot.round) continue;
    const c = model.cells[player][s.key];
    if (c && c.settled) prev = c;
  }
  const cellOf = name => {
    const p = model.players.find(q => norm(q) === norm(name));
    const c = p && model.cells[p][slot.key];
    return c && c.settled ? c : null;
  };
  return { model, player, slot, prev, others, cellOf };
}

// "qualifying.max_points & picked_driver:VER"  ->  [{session:'qualifying', name:'max_points'}, {session:null, name:'picked_driver', arg:'VER'}]
function parseCondition(text) {
  return String(text).split('&').map(raw => {
    let part = raw.trim(), session = null;
    const dot = part.match(/^([a-z]+)\.(.+)$/i);
    if (dot && SESSIONS[dot[1].toLowerCase()]) { session = dot[1].toLowerCase(); part = dot[2].trim(); }
    const i = part.indexOf(':');
    return { session, name: (i < 0 ? part : part.slice(0, i)).trim(), arg: i < 0 ? undefined : part.slice(i + 1).trim() };
  });
}

function evaluateAchievements(model, defs) {
  return defs.filter(d => d.name && d.condition).map(def => {
    const times = Number(def.times) || 1;
    const streak = isYes(def.streak);
    const sess = (def.session || 'race').toLowerCase();
    const holders = [];
    const parts = parseCondition(def.condition);
    const argOf = p => p.arg !== undefined ? p.arg : (def.threshold || '');

    if (parts.length === 1 && !parts[0].session && SEASON_CONDITIONS[parts[0].name]) {
      model.totals.forEach(tot => {
        const at = SEASON_CONDITIONS[parts[0].name](tot.player, argOf(parts[0]), model);
        if (at) holders.push({ player: tot.player, at });
      });
      return { def, holders };
    }
    const bad = parts.find(p => !ROUND_CONDITIONS[p.name]);
    if (bad) {
      return { def, holders, error: SEASON_CONDITIONS[bad.name]
        ? `"${bad.name}" can't be combined with other conditions`
        : `Unknown condition "${bad.name}"` };
    }

    model.totals.forEach(tot => {
      let run = 0, count = 0, at = null;
      for (const s of model.slots) {
        if (sess !== 'any' && s.session !== sess) continue;
        const own = model.cells[tot.player][s.key];
        if (!own || !own.settled) continue;
        const ok = parts.every(p => {
          const slot = p.session ? model.slots.find(z => z.round === s.round && z.session === p.session) : s;
          const c = slot && model.cells[tot.player][slot.key];
          return !!c && c.settled && !!ROUND_CONDITIONS[p.name](c, argOf(p), makeCtx(model, tot.player, slot));
        });
        if (ok) { run++; count++; } else run = 0;
        if (!at && (streak ? run : count) >= times) at = s.label;
      }
      if (at) holders.push({ player: tot.player, at });
    });
    return { def, holders };
  });
}
