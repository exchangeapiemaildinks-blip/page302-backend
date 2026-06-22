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

// Per-match lineup data, from the same /matches/{id} detail call as goals.
// Keyed by match id. Stores { home, away } each with { formation, lineup, bench, coach }.
const lineupCache = new Map();

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

// Lineups drop ~1hr before kickoff. Fetch for any upcoming match within
// 2hrs of kickoff, plus all started matches (they'll already be fetched
// for goals — this just also extracts the lineup from the same call).
const LINEUP_WINDOW_MS = 2 * 60 * 60 * 1000;
function needsLineup(m) {
  if (lineupCache.has(m.id) && m.status === 'FINISHED') return false; // cache forever when done
  if (m.status === 'IN_PLAY' || m.status === 'PAUSED' || m.status === 'FINISHED') return true;
  if (m.status !== 'TIMED' && m.status !== 'SCHEDULED') return false;
  return (new Date(m.utcDate).getTime() - Date.now()) < LINEUP_WINDOW_MS;
}

function extractLineup(teamData) {
  if (!teamData) return null;
  return {
    formation: teamData.formation || null,
    lineup: (teamData.lineup || []).map(p => ({
      shirt: p.shirtNumber,
      name: p.name,
      pos: p.position,
    })),
    bench: (teamData.bench || []).map(p => ({
      shirt: p.shirtNumber,
      name: p.name,
      pos: p.position,
    })),
    coach: (teamData.coach && teamData.coach.name) || null,
  };
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

// Populates goalsCache and lineupCache for matches that need it.
// Key rules:
// - FINISHED matches: fetch once, cache forever — but ONLY on success.
//   A failed/rate-limited fetch must NOT be cached as empty, or we'll
//   never retry and scorers will be permanently missing.
// - IN_PLAY/PAUSED: always re-fetch (score/scorers changing)
// - TIMED: re-fetch if cached lineup is empty (lineups drop ~1hr before KO)
// - Rate limiting: small delay between calls to avoid hitting football-data.org limits
async function populateGoalsCache(rawMatches) {
  const delay = ms => new Promise(r => setTimeout(r, ms));

  for (const m of rawMatches) {
    const wantsGoals = needsGoals(m);
    const wantsLineup = needsLineup(m);
    if (!wantsGoals && !wantsLineup) continue;

    const isLive = m.status === 'IN_PLAY' || m.status === 'PAUSED';
    const isTimed = m.status === 'TIMED' || m.status === 'SCHEDULED';
    const isFinished = m.status === 'FINISHED';

    const cachedGoals = goalsCache.get(m.id);
    const cachedLineup = lineupCache.get(m.id);
    const lineupIsEmpty = !cachedLineup || !cachedLineup.home || !cachedLineup.home.lineup || cachedLineup.home.lineup.length === 0;

    // For FINISHED matches: skip only if we have BOTH goals and lineup cached.
    // If goals cache exists but is empty, it could be an error result — retry.
    // (Live matches always re-fetch; TIMED re-fetch until lineup populated.)
    if (isFinished && cachedGoals && cachedGoals.length > 0 && !lineupIsEmpty) continue;
    if (isFinished && !wantsLineup && cachedGoals && cachedGoals.length > 0) continue;
    if (!isLive && isTimed && !wantsGoals && !lineupIsEmpty) continue;

    try {
      const detail = await fetchFD(`/matches/${m.id}`);
      const goals = detail.goals || [];
      if (wantsGoals) {
        // Only cache if we got a real response — empty goals on a FINISHED
        // match with a non-zero score is suspicious; cache anyway but it'll
        // be retried next cycle since goals.length === 0.
        goalsCache.set(m.id, goals);
      }
      const home = extractLineup(detail.homeTeam);
      const away = extractLineup(detail.awayTeam);
      const homeHasPlayers = home && home.lineup && home.lineup.length > 0;
      if (homeHasPlayers) {
        lineupCache.set(m.id, { home, away });
      } else if (!isTimed) {
        if (!lineupCache.has(m.id)) lineupCache.set(m.id, { home, away });
      }
      // Small delay between calls — keeps us well inside the 30 req/min
      // rate limit on Deep Data tier even with a full tournament dataset.
      await delay(300);
    } catch (e) {
      // Do NOT cache on error — leave the entry absent so we retry next cycle.
      console.error('detail fetch failed for match', m.id, ':', e.message);
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

  const lineups = lineupCache.get(m.id) || null;

  return {
    home: (m.homeTeam && m.homeTeam.name || 'TBD').toUpperCase(),
    away: (m.awayTeam && m.awayTeam.name || 'TBD').toUpperCase(),
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
    const t0 = Date.now();
    await populateGoalsCache(data.matches || []);
    console.log(`populateGoalsCache: ${Date.now()-t0}ms for ${(data.matches||[]).length} raw matches`);
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
  if (!firstRefreshDone) resolvePendingFeed();
}

const app = express();
app.use(cors()); // public read-only feed — safe to allow any origin

// Block /feed until the first refresh() has fully completed (including
// populateGoalsCache). Without this, a frontend request that lands during
// Render's boot gets an empty cache — matches with no scorers/lineups.
let firstRefreshDone = false;
const pendingFeedRequests = [];

function resolvePendingFeed() {
  firstRefreshDone = true;
  pendingFeedRequests.forEach(({ res }) => res.json(cache));
  pendingFeedRequests.length = 0;
}

app.get('/feed', (req, res) => {
  if (firstRefreshDone) return res.json(cache);
  // First refresh still in flight — hold the request (max 45s, then serve
  // whatever partial cache we have rather than letting it hang forever).
  const timeout = setTimeout(() => {
    const idx = pendingFeedRequests.findIndex(r => r.res === res);
    if (idx !== -1) { pendingFeedRequests.splice(idx, 1); res.json(cache); }
  }, 45000);
  pendingFeedRequests.push({ res, timeout });
});
app.get('/debug', (req, res) => res.json(debugInfo));

// Returns all knockout fixtures (LAST_32, LAST_16, QUARTER_FINALS etc) with
// their IDs and utcDate — lets us map football-data.org match IDs to the
// known FIFA bracket slots by cross-referencing kickoff dates/times.
app.get('/debug/knockout', (req, res) => {
  const knockoutStages = ['LAST_32','LAST_16','QUARTER_FINALS','SEMI_FINALS','THIRD_PLACE','FINAL'];
  const matches = (debugInfo.rawMatches || [])
    .filter(m => knockoutStages.includes(m.stage))
    .map(m => ({
      id: m.id,
      stage: m.stage,
      utcDate: m.utcDate,
      home: m.homeTeam && m.homeTeam.name,
      away: m.awayTeam && m.awayTeam.name,
      status: m.status
    }))
    .sort((a,b) => new Date(a.utcDate) - new Date(b.utcDate));
  res.json(matches);
});

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
