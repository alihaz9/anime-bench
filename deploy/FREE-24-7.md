# free 24/7 — the actual picks

Checked against the live APIs on 2026-10-28, not from memory.

| host | card | sleeps | hour cap | verdict |
| --- | --- | --- | --- | --- |
| **Render** free web (docker) | no | 15 min idle | 750 h/mo | **use this** — repo as-is, keepalive holds it awake |
| Hugging Face Docker Space | no card, but **PRO required** | — | — | dead end: api answers `402 Static Spaces are free for everyone, but hosting Gradio and Docker Spaces on free cpu-basic requires a PRO subscription` |
| Hugging Face **Static** Space | no | — | none | frontend only — no node, so `/api/*` dies |
| Koyeb free | asks card | — | — | skip |
| Fly.io / Railway / Replit / Zeabur | card or paid | — | — | skip |
| Oracle always-free VM | card for verify | no | none | true 24/7, but a card on file |
| Cloudflare Tunnel to your PC | no | — | — | dies when the PC sleeps |

Render free is 750 h against 744 h in a 31-day month — one service, kept warm by a 10 min ping,
fits. Cold start after a sleep is ~40 s; the ping is what you never feel it.

Video bytes never cross the container: the browser plays the cdn url directly and only falls
back to `/api/stream`. That is what keeps a free box viable.

---

## 1. github (the spine — render and the cron both read it)

```powershell
# github.com/settings/tokens -> classic -> scope: repo
cd "C:\Users\khadr\OneDrive\Documents\Default Project"
.\deploy\render-push.ps1 -Repo "Alikhadra101/anime-bench" -Token "ghp_xxxxxxxx"
```

Creates the repo if it is missing, commits the tree, pushes `main`. The token rides an
`http.extraheader` on the push only — it is never written into `.git/config`.

## 2. render

render.com → sign in with GitHub (no card) → **New → Blueprint** → pick `anime-bench` →
Apply. `render.yaml` already declares: docker runtime, free plan, frankfurt,
healthCheck `/api/health`, `TRUST_PROXY=1`, `CACHE_MAX=600`.

First build ~4 min (npm ci + copy). URL: `https://anime-bench.onrender.com` (name is taken →
Render appends a suffix, copy the real one).

Set `ACCESS_CODE` in the dashboard if the link should stay private.

## 3. keepalive

GitHub Action, 10 min, pings `/api/health` on every url in the secret:

```powershell
# repo -> Settings -> Secrets and variables -> Actions -> New secret
#   PING_URLS = https://anime-bench.onrender.com
```

`.github/workflows/keepalive.yml` does the rest. Test: Actions → keepalive → Run workflow.

Github cron drifts 5–15 min and pauses after 60 days of repo inactivity, while Render sleeps at
15 min — so put **uptimerobot.com** (free, 5 min, no card) on the same `/api/health` url too.
That pair is what actually holds 24/7.

## 4. anime4up from a datacenter host

anime4up answers **403** to vercel/render IPs — a cloudflare rule, not a code bug.
`/api/health/upstreams` shows it per host. animesuge still answers, so the site works
without this; the deep catalog comes back when a worker fetches a4 for it.

```powershell
npm i -g wrangler
wrangler login                                  # free plan, no card
cd "C:\Users\khadr\OneDrive\Documents\Default Project\deploy\a4-proxy"
wrangler deploy
# copy the printed https://a4-proxy.<subdomain>.workers.dev

cd ..\..
npx vercel env add ANIME4UP_PROXY production    # paste the worker url
npx vercel deploy --prod --yes --name anime-bench
```

The worker only forwards GETs to the five a4 hosts, nothing else. Free plan is
100k requests/day. Verify: `/api/health/upstreams` should show `anime4up:plain` 200,
and `/api/episodes/20` (Naruto) should come back with `provider: anime4up`, 220 eps.

Without the worker the server notices the 403 once and puts a4 at the back of the
queue for 10 minutes, so no request pays that timeout twice.

## 5. lock it down
`ACCESS_CODE` on the host makes `/` a key prompt and `/api/*` a 401 without it; the key sets
`ab_key` for 30 days. Share once with `?code=YOURCODE`, the cookie carries the rest. Rotate by
changing the var and redeploying.

## 5. limits to know

- Render free reboots on every deploy and after long idles: in-memory cache and rate-limit
  buckets reset. Nothing else is stored, so nothing is lost.
- Leave the keepalive off for a week and you get those hours back.
- Datacenter IP: AniList is fine. If animesuge answers `403` from the host but not from home,
  that is a source-side block — swap `ANIMESUGE_BASE` in `.env` and redeploy.
- Do not route video through `/api/stream` by default; the cdn path is what keeps it free.
- HF stays as a fallback the day a PRO sub exists — `deploy\hf-push.ps1` is already cut and
  stages a valid space.
