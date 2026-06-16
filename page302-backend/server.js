// Page 302 backend
// -----------------------------------------------------------------------------
// Small always-on service that polls football-data.org for World Cup 2026
// matches + standings, reshapes them into the { competition, subtitle, matches,
// table } shape the PWA's data.js expects, and serves it from GET /feed.
//
// Why a backend at all (vs calling football-data.org from the browser):
//   - football-data.org blocks browser (CORS) requests
//   - it would expose your API key to anyone who views page source
//   - caching here means N users = same 2 requests/min upstream, not N x 2
//
// Env vars (see .env.example):
//   FOOTBALL_DATA_API_KEY  - required, from football-data.org
//   COMPETITION_CODE       - default 'WC' (World Cup)
//   PORT                   - default 3000 (Render/Railway set this for you)
// -----------------------------------------------------------------------------

import express from 'express';
import cors from 'cors';

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const COMPETITION = process.env.COMPETITION_CODE || 'WC';
const BASE = 'https://api.football-data.org/v4';

if (!API_KEY) {
  console.error('Missing FOOTBALL_DATA_API_KEY env var. Get one free at https://www.football-data.org/client/register');
}

// In-memory cache. Served instantly; refreshed on a timer below.
let cache = { competition: 'WORLD CUP', subtitle: 'GROUP STAGE', matches: [], table: [], fetchedAt: null };

// Per-match goal events (scorer, minute, assist), fetched on demand from
// /matches/{id} since the list endpoint doesn't include them. Keyed by
// match id. FINISHED matches cache forever (goals don't change); IN_PLAY/
// PAUSED matches re-fetch every refresh to pick up new goals.
const goalsCache = new Map();

// Debug snapshot — last raw upstream data + any errors, for diagnosing
// mapping issues without needing to dig through host logs. See GET /debug.
let debugInfo = { lastError: { matches: null, standings: null }, rawMatches: null, rawStandings: null, fetchedAt: null };

const STAGE_LABELS = {
  GROUP_STAGE: 'GROUP STAGE',
  LAST_16: 'ROUND OF 16',
  LAST_32: 'ROUND OF 32',
  QUARTER_FINALS: 'QUARTER-FINALS',
  SEMI_FINALS: 'SEMI-FINALS',
  THIRD_PLACE: 'THIRD PLACE PLAY-OFF',
  FINAL: 'FINAL'
};

async function fetchFD(path) {
  const res = await fetch(BASE + path, { headers: {
    'X-Auth-Token': API_KEY || '',
    'X-Unfold-Goals': 'true',
    'X-Unfold-Lineups': 'true',
    'X-Unfold-Bookings': 'true',
    'X-Unfold-Subs': 'true',
  }});
  if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status);
  return res.json();
}

// matches use "GROUP_C", standings use "Group C" — same tournament, two formats.
// Both map to a bare letter "C"; anything else (knockout stages) -> null
function groupLetter(g) {
  if (!g) return null;
  const m = /GROUP[_\s]?([A-Za-z])$/i.exec(g);
  return m ? m[1].toUpperCase() : null;
}

// Goals only need fetching for matches that have actually started, and only
// for a recent window - the dataset now spans the whole tournament, and we
// don't want the first refresh after deploy to fire ~20+ goal-detail
// requests for long-finished matches nobody's looking at. 48h covers
// "today/yesterday" for any timezone; live matches are always included
// regardless of age (covers a match running past midnight).
const GOALS_WINDOW_MS = 48 * 60 * 60 * 1000;
function needsGoals(m) {
  if (m.status === 'IN_PLAY' || m.status === 'PAUSED') return true;
  if (m.status !== 'FINISHED') return false;
  return (Date.now() - new Date(m.utcDate).getTime()) < GOALS_WINDOW_MS;
}

// "SURNAME 90" / "SURNAME 90+6" / "SURNAME 67 PEN" / "SURNAME 23 OG" -
// matches the mock data's "MCTOMINAY 57" style. Surname = last word of the
// scorer's full name (an approximation - misses multi-word surnames like
// "van Dijk", but fits the compact teletext format much better than full names).
function formatScorer(goal) {
  const name = (goal.scorer && goal.scorer.name) || '';
  const surname = name.trim().split(/\s+/).pop().toUpperCase();
  let label = surname + ' ' + goal.minute;
  if (goal.injuryTime) label += '+' + goal.injuryTime;
  if (goal.type === 'PENALTY') label += ' PEN';
  else if (goal.type === 'OWN') label += ' OG';
  return label;
}

// Populates goalsCache for matches that need it. FINISHED matches are
// fetched once and cached forever; IN_PLAY/PAUSED matches re-fetch every
// refresh cycle to pick up new goals.
async function populateGoalsCache(rawMatches) {
  for (const m of rawMatches) {
    if (!needsGoals(m)) continue;
    const isLive = m.status === 'IN_PLAY' || m.status === 'PAUSED';
    if (!isLive && goalsCache.has(m.id)) continue;
    try {
      const detail = await fetchFD(`/matches/${m.id}`);
      goalsCache.set(m.id, detail.goals || []);
    } catch (e) {
      if (!goalsCache.has(m.id)) goalsCache.set(m.id, []);
      console.error('goals fetch failed for match', m.id, ':', e.message);
    }
  }
}


function mapMatch(m) {
  const ft = (m.score && m.score.fullTime) || {};
  // football-data.org has used both {home,away} and {homeTeam,awayTeam} keys
  // depending on endpoint/competition — accept either.
  const hs = ft.home ?? ft.homeTeam ?? 0;
  const as = ft.away ?? ft.awayTeam ?? 0;

  const homeId = m.homeTeam && m.homeTeam.id;
  const awayId = m.awayTeam && m.awayTeam.id;
  const goals = goalsCache.get(m.id) || [];
  const scorersHome = [], scorersAway = [];
  for (const g of goals) {
    if (!g.team) continue;
    const label = formatScorer(g);
    // goal.team is always the SCORER's own team. For a regular/penalty goal
    // that's also the team it counts for - but an own goal counts for the
    // OPPONENT, so flip which column it lands in.
    let creditId = g.team.id;
    if (g.type === 'OWN') {
      if (creditId === homeId) creditId = awayId;
      else if (creditId === awayId) creditId = homeId;
    }
    if (creditId === homeId) scorersHome.push(label);
    else if (creditId === awayId) scorersAway.push(label);
  }

  return {
    home: (m.homeTeam && m.homeTeam.name || 'TBD').toUpperCase(),
    away: (m.awayTeam && m.awayTeam.name || 'TBD').toUpperCase(),
    hs, as,
    status: m.status, // SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED
    minute: (typeof m.minute === 'number') ? m.minute : null,
    // Raw UTC ISO timestamp - the frontend formats this in the *viewer's*
    // local timezone. Don't pre-format here: the server's timezone (Render
    // runs UTC) has nothing to do with the user's.
    kickoff: m.utcDate,
    group: groupLetter(m.group),
    stage: m.stage || null,
    scorers: { home: scorersHome, away: scorersAway }
  };
}

function mapStandings(data) {
  const out = [];
  (data.standings || []).forEach(grp => {
    const g = groupLetter(grp.group);
    if (!g) return; // skip non-group (e.g. knockout) standings blocks
    (grp.table || []).forEach(row => {
      const gd = row.goalDifference ?? 0;
      out.push({
        group: g,
        name: (row.team && row.team.name || '').toUpperCase(),
        p: row.playedGames ?? 0,
        gd: (gd >= 0 ? '+' : '') + gd,
        pts: row.points ?? 0
      });
    });
  });
  return out;
}

function pickSubtitle(matches) {
  const live = matches.find(m => m.stage && (m.status === 'IN_PLAY' || m.status === 'PAUSED'));
  const stage = (live || matches[0] || {}).stage;
  return STAGE_LABELS[stage] || 'WORLD CUP';
}

async function refresh() {
  let matches = cache.matches, table = cache.table, subtitle = cache.subtitle, fetchedAt = cache.fetchedAt;

  try {
    // No date filter: fetch the whole competition's matches (one season,
    // ~104 for the World Cup). This lets the frontend group by the
    // *viewer's local* calendar day and navigate between days — a
    // server-side "today" filter can't do that correctly across timezones
    // (a 23:00 UTC kickoff is already "tomorrow" in BST).
    const data = await fetchFD(`/competitions/${COMPETITION}/matches`);
    await populateGoalsCache(data.matches || []);
    matches = (data.matches || []).map(mapMatch);
    subtitle = pickSubtitle(matches);
    fetchedAt = new Date().toISOString();
    debugInfo.lastError.matches = null;
    // raw snapshot of just the bits we care about, for diagnosing score/minute mapping
    debugInfo.rawMatches = (data.matches || []).map(m => ({
      id: m.id,
      home: m.homeTeam && m.homeTeam.name,
      away: m.awayTeam && m.awayTeam.name,
      status: m.status,
      minute: m.minute,
      score: m.score,
      group: m.group,
      stage: m.stage
    }));
  } catch (e) {
    debugInfo.lastError.matches = e.message;
    console.error('matches refresh failed:', e.message);
  }

  try {
    const data = await fetchFD(`/competitions/${COMPETITION}/standings`);
    table = mapStandings(data);
    debugInfo.lastError.standings = null;
    debugInfo.rawStandings = data;
  } catch (e) {
    // Standings can 404 once the group stage ends — not fatal, keep last-known table.
    debugInfo.lastError.standings = e.message;
    console.error('standings refresh failed:', e.message);
  }

  debugInfo.fetchedAt = new Date().toISOString();

  cache = { competition: 'WORLD CUP', subtitle, matches, table, fetchedAt };
  console.log(new Date().toISOString(), '- refreshed:', matches.length, 'matches,', table.length, 'table rows');
}

const app = express();
app.use(cors()); // public read-only feed — safe to allow any origin

app.get('/feed', (req, res) => res.json(cache));
app.get('/debug', (req, res) => res.json(debugInfo));

// On-demand: fetch one match's full detail (not part of the regular 60s
// poll, so it doesn't affect rate limits). Use this to check whether `goals`
// (scorer + minute) is present on this API key's tier.
//   GET /debug/match?id=<id from /debug rawMatches>
app.get('/debug/match', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'pass ?id=<match id from /debug rawMatches>' });
  try {
    const data = await fetchFD(`/matches/${id}`);
    res.json({
      id: data.id,
      status: data.status,
      score: data.score,
      goals: data.goals,
      homeTeam: data.homeTeam && data.homeTeam.name,
      awayTeam: data.awayTeam && data.awayTeam.name
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// On-demand: fetch one match's lineup/formation data to verify shape.
//   GET /debug/lineup?id=<match id>
app.get('/debug/lineup', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'pass ?id=<match id>' });
  try {
    const data = await fetchFD(`/matches/${id}`);
    res.json({
      id: data.id,
      status: data.status,
      homeTeam: {
        name: data.homeTeam && data.homeTeam.name,
        formation: data.homeTeam && data.homeTeam.formation,
        lineup: data.homeTeam && data.homeTeam.lineup,
        bench: data.homeTeam && data.homeTeam.bench,
        coach: data.homeTeam && data.homeTeam.coach,
      },
      awayTeam: {
        name: data.awayTeam && data.awayTeam.name,
        formation: data.awayTeam && data.awayTeam.formation,
        lineup: data.awayTeam && data.awayTeam.lineup,
        bench: data.awayTeam && data.awayTeam.bench,
        coach: data.awayTeam && data.awayTeam.coach,
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('Page 302 backend is running. Try /feed or /debug'));

refresh(); // populate cache immediately on boot
setInterval(refresh, 60_000); // football-data.org free tier allows far more than 1 req/min

app.listen(PORT, () => console.log('Page 302 backend listening on port ' + PORT));
