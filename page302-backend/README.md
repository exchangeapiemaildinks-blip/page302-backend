# Page 302 backend

A tiny always-on service that polls football-data.org for World Cup 2026
matches and group standings, and serves them in the exact shape the
Page 302 PWA expects.

## What it does

- Polls `https://api.football-data.org/v4/competitions/WC/matches` (today's
  fixtures) and `.../standings` every 60 seconds
- Reshapes the response into `{ competition, subtitle, matches, table }`
- Serves that from `GET /feed`, with CORS enabled (it's a public read-only
  scores feed, safe for any origin)

## Running locally

```
npm install
cp .env.example .env   # then edit .env and add your real API key
npm start
```

Then open http://localhost:3000/feed — you should see JSON.

## Deploying

See `../GOING-LIVE-BACKEND.md` for the full step-by-step (get an API key,
deploy to Render, wire the PWA up to it).

## Known limitations (honest, on purpose)

- **Goal scorers are always empty.** football-data.org's match-list endpoint
  doesn't include them. The app already handles this gracefully — tapping a
  match to "reveal scorers" will just show nothing for live data. Getting real
  scorer data would mean either a paid API tier (API-Football) or fetching
  each match individually (rate-limit heavy).
- **Group standings may disappear once the group stage ends** — the
  `/standings` endpoint can stop returning group tables for knockout rounds.
  The backend handles this without crashing (keeps the last-known table), but
  page 303 may go quiet during the knockouts. Not a priority to fix mid-tournament.
- **`subtitle`** is derived from match `stage` (GROUP STAGE, ROUND OF 16, etc.)
  but isn't currently shown in the app's header — it's there for future use.
