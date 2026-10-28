# anime bench

Browser anime site: AniList metadata, animesuge sources, local progress.
Nothing is stored on this server — it resolves and plays.

## run

```bash
npm install
cp .env.example .env
npm start
# http://localhost:8787
```

No Docker, no external API keys. Playback resolves against `ANIMESUGE_BASE`
(default `https://animesuge.lol`) at request time.

## how playback works

1. `GET /api/episodes/:id` matches the AniList title to an animesuge series and
   returns its episode list (`as:<slug>` ids).
2. `GET /api/watch/as:<slug>` fetches the provider's watch page and pulls out the
   player it embeds, then returns one of two source shapes:
   - `{ url: "….mp4", isEmbed: false }` — played natively in the page `<video>`;
   - `{ url: "https://player…/embed/…", isEmbed: true }` — framed in an iframe.
3. If the provider's player is down for that episode the route answers `404` and
   the player shows `mirror offline`. Nothing to fix locally — the mirror is dead.

## routes

| route | shape |
| --- | --- |
| `GET /api/home` | hero + trending + current season |
| `GET /api/search?q=` | AniList search, min 2 chars |
| `GET /api/anime/:id` | AniList detail |
| `GET /api/episodes/:id?dub=1` | title match → episode list |
| `GET /api/watch/:episodeId` | one source: direct file or provider embed |
| `GET /api/stream?url=&ref=` | HLS manifest rewrite + segment pipe (fallback) |
| `GET /api/health` | uptime |

## build notes

- Node 20+ (uses global `fetch`, `AbortSignal.timeout`).
- Cache is in-process; restart wipes it. TTLs in `.env`.
- Rate limits: 60/min general, 600/min on `/api/stream` (HLS fires many segments).
- Episode lists are scraped from the provider's WordPress REST API plus its series
  page, then filtered to the AniList episode count.
- Title matching scores token overlap, quiet on season/part conflicts, and needs a
  `0.4` score before it trusts a result. Movies prefer `/movie|film/` shelves.
- `hls.js` comes from CDN in `web/index.html`; Safari plays native HLS.
- Progress and list live in `localStorage`, keyed `ab.progress.v1` / `ab.list.v1`.
- Keys: `/` search, `n`/`p` next/prev episode, `space` play, `f` fullscreen, `m` mute.
- Static files are served `no-cache` and versioned (`app.js?v=`) so edits show up on reload.

## gotchas

| symptom | cause |
| --- | --- |
| `no matching source for this anime` | title mismatch — provider search is fuzzy; try the romaji name |
| `source has no episodes for this title` | series exists but has no episode posts (or only a movie) |
| `mirror offline` | the provider's player file/embed for that episode is gone |
| `no playable stream` | the provider page had no `<iframe>` player at all |
| video stays black, controls move | host blocks hotlinking by referer — reload; if it persists, the mirror changed |
| dub empty | provider has no dub track for that title |

`CONSUMET_*` vars are a legacy fallback and are unused while animesuge answers.
