// Page 302 backend
// -----------------------------------------------------------------------------
// Polls football-data.org for match data across multiple competitions,
// serves each via GET /feed?comp=ELC (or WC, PL, etc).
// Each competition gets its own in-memory cache; goals/lineup caches are
// shared (match IDs are globally unique across competitions).
//
// Env vars:
//   FOOTBALL_DATA_API_KEY  - required
//   DEFAULT_COMP           - default competition code if ?comp omitted (default: ELC)
//   PORT                   - default 3000
// -----------------------------------------------------------------------------

import express from 'express';
import cors from 'cors';

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const DEFAULT_COMP = process.env.DEFAULT_COMP || 'ELC';
const BASE = 'https://api.football-data.org/v4';

if (!API_KEY) {
  console.error('Missing FOOTBALL_DATA_API_KEY env var.');
}

// ---- Competition config ------------------------------------------------------
// Only include competitions that are actually active/subscribed.
// Add/remove here as seasons start and end — inactive ones waste API quota.
const COMPETITIONS = {
  ELC: { name: 'CHAMPIONSHIP',    label: 'CHAMPIONSHIP',    type: 'league'  },
  PL:  { name: 'PREMIER LEAGUE',  label: 'PREMIER LEAGUE',  type: 'league'  },
  // Add WC/CL/EC back here when their seasons are active and subscribed:
  // WC:  { name: 'WORLD CUP',    label: 'WORLD CUP',    type: 'tournament' },
  // CL:  { name: 'CHAMPIONS LEAGUE', label: 'CHAMPIONS LEAGUE', type: 'league' },
};

// ---- Per-competition cache ---------------------------------------------------
// Each competition gets its own cache entry. Keyed by competition code.
const compCache = {};
const compFirstDone = {};
const compPending = {};

function initCompCache(code) {
  const cfg = COMPETITIONS[code] || { name: code, label: code, type: 'league' };
  compCache[code] = { competition: cfg.name, subtitle: cfg.label, matches: [], table: [], fetchedAt: null };
  compFirstDone[code] = false;
  compPending[code] = [];
}

Object.keys(COMPETITIONS).forEach(initCompCache);

// ---- Shared goals/lineup cache (match IDs are globally unique) --------------
const goalsCache = new Map();
const lineupCache = new Map();

let debugInfo = { lastError: {}, rawMatches: {}, fetchedAt: null };

// ---- API helper -------------------------------------------------------------
async function fetchFD(path) {
  const apiRes = await fetch(BASE + path, { headers: {
    'X-Auth-Token': API_KEY || '',
    'X-Unfold-Goals': 'true',
    'X-Unfold-Lineups': 'true',
    'X-Unfold-Bookings': 'true',
    'X-Unfold-Subs': 'true',
  }});
  if (!apiRes.ok) throw new Error(path + ' -> HTTP ' + apiRes.status);
  return apiRes.json();
}

// ---- Scorer formatting ------------------------------------------------------
function formatScorer(goal) {
  const name = (goal.scorer && goal.scorer.name) || '';
  const surname = name.trim().split(/\s+/).pop().toUpperCase();
  let label = surname + ' ' + goal.minute;
  if (goal.injuryTime) label += '+' + goal.injuryTime;
  if (goal.type === 'PENALTY') label += ' PEN';
  else if (goal.type === 'OWN') label += ' OG';
  return label;
}

// ---- Goals/lineup cache population ------------------------------------------
// Tighter window — 24h covers yesterday + today which is all users actually need.
// 48h was doubling the number of detail fetches unnecessarily.
const GOALS_WINDOW_MS = 24 * 60 * 60 * 1000;
const LINEUP_WINDOW_MS = 2 * 60 * 60 * 1000;

// Rate limit budget:
// 30 req/min = 1 req per 2 seconds.
// We have 2 comps × 2 base calls = 4 base calls per cycle.
// Remaining budget for detail calls: 26/min across the full 60s cycle.
// 2.5s delay between detail calls = max 24 detail calls per comp refresh.
// With 2 comps refreshed alternately (ELC at 0s, PL at 30s), each gets
// ~24 detail call slots without overlapping — well within limits.
const DETAIL_CALL_DELAY_MS = 2500;

function needsGoals(m) {
  if (m.status === 'IN_PLAY' || m.status === 'PAUSED') return true;
  if (m.status !== 'FINISHED') return false;
  return (Date.now() - new Date(m.utcDate).getTime()) < GOALS_WINDOW_MS;
}

function needsLineup(m) {
  if (lineupCache.has(m.id) && m.status === 'FINISHED') return false;
  if (m.status === 'IN_PLAY' || m.status === 'PAUSED' || m.status === 'FINISHED') return true;
  if (m.status !== 'TIMED' && m.status !== 'SCHEDULED') return false;
  return (new Date(m.utcDate).getTime() - Date.now()) < LINEUP_WINDOW_MS;
}

function extractLineup(teamData) {
  if (!teamData) return null;
  return {
    formation: teamData.formation || null,
    lineup: (teamData.lineup || []).map(p => ({ shirt: p.shirtNumber, name: p.name, pos: p.position })),
    bench:  (teamData.bench  || []).map(p => ({ shirt: p.shirtNumber, name: p.name, pos: p.position })),
    coach: (teamData.coach && teamData.coach.name) || null,
  };
}

async function populateGoalsCache(rawMatches) {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  // Hard cap: never make more than 20 detail calls per refresh cycle.
  // At 2.5s each that's 50s of calls — leaves headroom for base calls.
  const MAX_DETAIL_CALLS = 20;
  let detailCallCount = 0;

  for (const m of rawMatches) {
    if (detailCallCount >= MAX_DETAIL_CALLS) {
      console.warn(`[detail] hit cap of ${MAX_DETAIL_CALLS} calls, skipping remaining matches this cycle`);
      break;
    }
    const wantsGoals  = needsGoals(m);
    const wantsLineup = needsLineup(m);
    if (!wantsGoals && !wantsLineup) continue;

    const isLive     = m.status === 'IN_PLAY' || m.status === 'PAUSED';
    const isTimed    = m.status === 'TIMED' || m.status === 'SCHEDULED';
    const isFinished = m.status === 'FINISHED';

    const cachedGoals  = goalsCache.get(m.id);
    const cachedLineup = lineupCache.get(m.id);
    const lineupEmpty  = !cachedLineup || !cachedLineup.home || !cachedLineup.home.lineup || cachedLineup.home.lineup.length === 0;

    if (isFinished && cachedGoals && cachedGoals.length > 0 && !lineupEmpty) continue;
    if (isFinished && !wantsLineup && cachedGoals && cachedGoals.length > 0) continue;
    if (!isLive && isTimed && !wantsGoals && !lineupEmpty) continue;

    try {
      detailCallCount++;
      const detail = await fetchFD(`/matches/${m.id}`);
      if (wantsGoals) goalsCache.set(m.id, detail.goals || []);
      const home = extractLineup(detail.homeTeam);
      const away = extractLineup(detail.awayTeam);
      const homeHasPlayers = home && home.lineup && home.lineup.length > 0;
      if (homeHasPlayers) {
        lineupCache.set(m.id, { home, away });
      } else if (!isTimed) {
        if (!lineupCache.has(m.id)) lineupCache.set(m.id, { home, away });
      }
      await delay(DETAIL_CALL_DELAY_MS);
    } catch (e) {
      console.error('detail fetch failed for match', m.id, ':', e.message);
    }
  }
}

// ---- Match mapping ----------------------------------------------------------
// WC bracket lookup (match IDs mapped to slot descriptions)
const BRACKET = {
  537417: { home: 'Runner-up A',  away: 'Runner-up B' },
  537423: { home: 'Winner E',     away: 'Best 3rd (A/B/C/D/F)' },
  537415: { home: 'Winner F',     away: 'Runner-up C' },
  537418: { home: 'Winner C',     away: 'Runner-up F' },
  537424: { home: 'Winner I',     away: 'Best 3rd (C/D/F/G/H)' },
  537416: { home: 'Runner-up E',  away: 'Runner-up I' },
  537425: { home: 'Winner A',     away: 'Best 3rd (C/E/F/H/I)' },
  537426: { home: 'Winner L',     away: 'Best 3rd (E/H/I/J/K)' },
  537422: { home: 'Winner D',     away: 'Best 3rd (B/E/F/I/J)' },
  537421: { home: 'Winner G',     away: 'Best 3rd (A/E/H/I/J)' },
  537420: { home: 'Runner-up K',  away: 'Runner-up L' },
  537419: { home: 'Winner H',     away: 'Runner-up J' },
  537429: { home: 'Winner B',     away: 'Best 3rd (E/F/G/I/J)' },
  537428: { home: 'Winner J',     away: 'Runner-up H' },
  537427: { home: 'Winner K',     away: 'Best 3rd (D/E/I/J/L)' },
  537430: { home: 'Runner-up D',  away: 'Runner-up G' },
};

function mapMatch(m) {
  const ft = (m.score && m.score.fullTime) || {};
  const hs = ft.home ?? ft.homeTeam ?? 0;
  const as = ft.away ?? ft.awayTeam ?? 0;

  const homeId = m.homeTeam && m.homeTeam.id;
  const awayId = m.awayTeam && m.awayTeam.id;
  const goals = goalsCache.get(m.id) || [];
  const scorersHome = [], scorersAway = [];
  for (const g of goals) {
    if (!g.team) continue;
    const label = formatScorer(g);
    let creditId = g.team.id;
    if (g.type === 'OWN') {
      if (creditId === homeId) creditId = awayId;
      else if (creditId === awayId) creditId = homeId;
    }
    if (creditId === homeId) scorersHome.push(label);
    else if (creditId === awayId) scorersAway.push(label);
  }

  const lineups = lineupCache.get(m.id) || null;
  const bracket = BRACKET[m.id];
  const homeName = (m.homeTeam && m.homeTeam.name) || (bracket && bracket.home) || 'TBD';
  const awayName = (m.awayTeam && m.awayTeam.name) || (bracket && bracket.away) || 'TBD';

  return {
    home: homeName.toUpperCase(),
    away: awayName.toUpperCase(),
    hs, as,
    status: m.status,
    minute: (typeof m.minute === 'number') ? m.minute : null,
    kickoff: m.utcDate,
    group: groupLetter(m.group),
    stage: m.stage || null,
    scorers: { home: scorersHome, away: scorersAway },
    lineups,
  };
}

function groupLetter(g) {
  if (!g) return null;
  const m = /GROUP[_\s]?([A-Za-z])$/i.exec(g);
  return m ? m[1].toUpperCase() : null;
}

// ---- Standings mapping ------------------------------------------------------
// Handles both grouped (tournament) and single-table (league) standings.
function mapStandings(data, type) {
  const out = [];
  (data.standings || []).forEach(grp => {
    if (type === 'league') {
      // League: single TOTAL table, no group letter needed
      if (grp.type && grp.type !== 'TOTAL') return;
      (grp.table || []).forEach(row => {
        const gd = row.goalDifference ?? 0;
        out.push({
          group: null, // no groups in a league
          pos: row.position,
          name: (row.team && row.team.name || '').toUpperCase(),
          p:  row.playedGames ?? 0,
          w:  row.won ?? 0,
          d:  row.draw ?? 0,
          l:  row.lost ?? 0,
          gd: (gd >= 0 ? '+' : '') + gd,
          pts: row.points ?? 0,
          form: row.form || null,
        });
      });
    } else {
      // Tournament: grouped table
      const g = groupLetter(grp.group);
      if (!g) return;
      (grp.table || []).forEach(row => {
        const gd = row.goalDifference ?? 0;
        out.push({
          group: g,
          name: (row.team && row.team.name || '').toUpperCase(),
          p: row.playedGames ?? 0,
          gd: (gd >= 0 ? '+' : '') + gd,
          pts: row.points ?? 0,
        });
      });
    }
  });
  return out;
}

// ---- Subtitle ---------------------------------------------------------------
const STAGE_LABELS = {
  GROUP_STAGE: 'GROUP STAGE', LAST_32: 'ROUND OF 32', LAST_16: 'ROUND OF 16',
  QUARTER_FINALS: 'QUARTER-FINALS', SEMI_FINALS: 'SEMI-FINALS',
  THIRD_PLACE: 'THIRD PLACE PLAY-OFF', FINAL: 'FINAL',
  REGULAR_SEASON: 'REGULAR SEASON', PLAYOFFS: 'PLAY-OFFS',
};

function pickSubtitle(matches, compCode) {
  const cfg = COMPETITIONS[compCode] || {};
  if (cfg.type === 'league') return cfg.label || compCode;
  const live = matches.find(m => m.stage && (m.status === 'IN_PLAY' || m.status === 'PAUSED'));
  const stage = (live || matches[0] || {}).stage;
  return STAGE_LABELS[stage] || cfg.label || compCode;
}

// ---- Per-competition refresh ------------------------------------------------
async function refreshComp(code) {
  const cfg = COMPETITIONS[code] || { name: code, label: code, type: 'league' };
  let { matches, table, subtitle, fetchedAt } = compCache[code];

  try {
    const data = await fetchFD(`/competitions/${code}/matches`);
    const t0 = Date.now();
    await populateGoalsCache(data.matches || []);
    console.log(`[${code}] populateGoalsCache: ${Date.now()-t0}ms for ${(data.matches||[]).length} matches`);
    matches = (data.matches || []).map(mapMatch);
    subtitle = pickSubtitle(matches, code);
    fetchedAt = new Date().toISOString();
    debugInfo.lastError[code + '_matches'] = null;
    debugInfo.rawMatches[code] = (data.matches || []).map(m => ({
      id: m.id, home: m.homeTeam && m.homeTeam.name, away: m.awayTeam && m.awayTeam.name,
      status: m.status, minute: m.minute, score: m.score, group: m.group,
      stage: m.stage, utcDate: m.utcDate,
    }));
  } catch (e) {
    debugInfo.lastError[code + '_matches'] = e.message;
    console.error(`[${code}] matches refresh failed:`, e.message);
  }

  try {
    const data = await fetchFD(`/competitions/${code}/standings`);
    table = mapStandings(data, cfg.type);
    debugInfo.lastError[code + '_standings'] = null;
  } catch (e) {
    debugInfo.lastError[code + '_standings'] = e.message;
    console.error(`[${code}] standings refresh failed:`, e.message);
  }

  compCache[code] = { competition: cfg.name, subtitle, matches, table, fetchedAt };
  console.log(`[${code}] refreshed: ${matches.length} matches, ${table.length} table rows`);

  if (!compFirstDone[code]) {
    compFirstDone[code] = true;
    const pending = compPending[code] || [];
    pending.forEach(({ res, timeout }) => { clearTimeout(timeout); res.json(compCache[code]); });
    compPending[code] = [];
  }
}

async function refreshAll() {
  debugInfo.fetchedAt = new Date().toISOString();
  const codes = Object.keys(COMPETITIONS);
  // Stagger competitions evenly across the 60s cycle so their API calls
  // don't overlap. With 2 comps and 60s interval: ELC at 0s, PL at 30s.
  const staggerMs = codes.length > 1 ? Math.floor(60000 / codes.length) : 0;
  for (let i = 0; i < codes.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, staggerMs));
    await refreshComp(codes[i]);
  }
}

// ---- Express ----------------------------------------------------------------
const app = express();
app.use(cors());

app.get('/feed', (req, res) => {
  const code = (req.query.comp || DEFAULT_COMP).toUpperCase();
  if (!COMPETITIONS[code]) return res.status(400).json({ error: `Unknown competition: ${code}` });

  if (compFirstDone[code]) return res.json(compCache[code]);

  // First refresh still in flight — hold the request (max 45s)
  const timeout = setTimeout(() => {
    const arr = compPending[code] || [];
    const idx = arr.findIndex(r => r.res === res);
    if (idx !== -1) { arr.splice(idx, 1); res.json(compCache[code]); }
  }, 45000);
  (compPending[code] = compPending[code] || []).push({ res, timeout });
});

// List all available competitions
app.get('/competitions', (req, res) => {
  res.json(Object.entries(COMPETITIONS).map(([code, cfg]) => ({
    code, name: cfg.name, type: cfg.type,
    fetchedAt: (compCache[code] || {}).fetchedAt || null,
  })));
});

app.get('/debug', (req, res) => res.json(debugInfo));

app.get('/debug/knockout', (req, res) => {
  const knockoutStages = ['LAST_32','LAST_16','QUARTER_FINALS','SEMI_FINALS','THIRD_PLACE','FINAL'];
  const raw = (debugInfo.rawMatches['WC'] || [])
    .filter(m => knockoutStages.includes(m.stage))
    .map(m => ({ id: m.id, stage: m.stage, utcDate: m.utcDate || null,
      home: m.home || null, away: m.away || null, status: m.status }))
    .sort((a,b) => a.utcDate && b.utcDate ? new Date(a.utcDate)-new Date(b.utcDate) : a.id-b.id);
  res.json(raw);
});

app.get('/debug/match', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'pass ?id=<match id>' });
  try {
    const data = await fetchFD(`/matches/${id}`);
    res.json({ id: data.id, status: data.status, score: data.score, goals: data.goals,
      homeTeam: data.homeTeam && data.homeTeam.name, awayTeam: data.awayTeam && data.awayTeam.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug/lineup', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'pass ?id=<match id>' });
  try {
    const data = await fetchFD(`/matches/${id}`);
    res.json({
      id: data.id, status: data.status,
      homeTeam: { name: data.homeTeam && data.homeTeam.name,
        formation: data.homeTeam && data.homeTeam.formation,
        lineup: data.homeTeam && data.homeTeam.lineup,
        bench: data.homeTeam && data.homeTeam.bench,
        coach: data.homeTeam && data.homeTeam.coach },
      awayTeam: { name: data.awayTeam && data.awayTeam.name,
        formation: data.awayTeam && data.awayTeam.formation,
        lineup: data.awayTeam && data.awayTeam.lineup,
        bench: data.awayTeam && data.awayTeam.bench,
        coach: data.awayTeam && data.awayTeam.coach },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('Page 302 backend. Try /feed?comp=ELC or /competitions'));

// Raw API test — calls football-data.org directly and returns the full response
// including headers, to diagnose 403 issues.
app.get('/debug/apitest', async (req, res) => {
  const key = process.env.FOOTBALL_DATA_API_KEY || '';
  try {
    const apiRes = await fetch('https://api.football-data.org/v4/competitions/ELC/matches?limit=1', {
      headers: { 'X-Auth-Token': key }
    });
    const body = await apiRes.text();
    res.json({
      status: apiRes.status,
      statusText: apiRes.statusText,
      headers: Object.fromEntries(apiRes.headers.entries()),
      body: body.slice(0, 500)
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

refreshAll();
setInterval(refreshAll, 60_000);

app.listen(PORT, () => console.log(`Page 302 backend listening on port ${PORT} (default comp: ${DEFAULT_COMP})`));
