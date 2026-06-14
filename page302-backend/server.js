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
let cache = { competition: 'WORLD CUP', subtitle: 'GROUP STAGE', matches: [], table: [] };

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
  const res = await fetch(BASE + path, { headers: { 'X-Auth-Token': API_KEY || '' } });
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

function mapMatch(m) {
  const ft = (m.score && m.score.fullTime) || {};
  // football-data.org has used both {home,away} and {homeTeam,awayTeam} keys
  // depending on endpoint/competition — accept either.
  const hs = ft.home ?? ft.homeTeam ?? 0;
  const as = ft.away ?? ft.awayTeam ?? 0;
  return {
    home: (m.homeTeam && m.homeTeam.name || 'TBD').toUpperCase(),
    away: (m.awayTeam && m.awayTeam.name || 'TBD').toUpperCase(),
    hs, as,
    status: m.status, // SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED
    minute: (typeof m.minute === 'number') ? m.minute : null,
    kickoff: new Date(m.utcDate).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    group: groupLetter(m.group),
    stage: m.stage || null,
    // football-data.org's match-list endpoint doesn't include goal scorers —
    // the app already renders an empty scorer list gracefully.
    scorers: { home: [], away: [] }
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
  // today (UTC) -> tomorrow; dateTo is exclusive, so this gets all of today's matches
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  let matches = cache.matches, table = cache.table, subtitle = cache.subtitle;

  try {
    const data = await fetchFD(`/competitions/${COMPETITION}/matches?dateFrom=${today}&dateTo=${tomorrow}`);
    matches = (data.matches || []).map(mapMatch);
    subtitle = pickSubtitle(matches);
    debugInfo.lastError.matches = null;
    // raw snapshot of just the bits we care about, for diagnosing score/minute mapping
    debugInfo.rawMatches = (data.matches || []).map(m => ({
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

  cache = { competition: 'WORLD CUP', subtitle, matches, table };
  console.log(new Date().toISOString(), '- refreshed:', matches.length, 'matches,', table.length, 'table rows');
}

const app = express();
app.use(cors()); // public read-only feed — safe to allow any origin

app.get('/feed', (req, res) => res.json(cache));
app.get('/debug', (req, res) => res.json(debugInfo));
app.get('/', (req, res) => res.send('Page 302 backend is running. Try /feed or /debug'));

refresh(); // populate cache immediately on boot
setInterval(refresh, 60_000); // football-data.org free tier allows far more than 1 req/min

app.listen(PORT, () => console.log('Page 302 backend listening on port ' + PORT));
