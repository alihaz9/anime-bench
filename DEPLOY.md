# run anime bench without your pc (free, no card)

your pc does two jobs: scraping anime4up/anilist, and proxying video. the second
one is gone — video now plays **straight from the cdn** (it sends
`access-control-allow-origin: *` and doesn't check referer), so the server only
ships json, posters and subtitle text. that changes the math completely:

| traffic | before (proxied video) | now (direct video) |
|---|---|---|
| one 1080p episode | 0.6–1 GB **through the host** | ~0 MB (a ~2 KB manifest) |
| a month of casual use | 20–100 GB | **~0.1–1 GB** (json + posters) |

so bandwidth is no longer the limit. the only thing to solve is keeping a free
instance awake.

---

## option 1 — render.com (recommended, no card)

free web service, https subdomain, no credit card. **750 running hours/month**,
512 MB ram, 5 GB egress (plenty now). free services sleep after **15 min idle**
and wake in ~30–60 s on the next request.

two ways to live with that:

- **sleep-tolerant** (zero setup): first click of the day takes ~40 s, then it's
  fast. the page shows skeletons, so it looks slow, not broken.
- **always awake** (what you asked for): a free uptime pinger hits
  `https://<your-site>.onrender.com/api/health` every 5 minutes. 5 min < 15 min,
  so it never sleeps. 744 h ≈ the 750 h allowance, so it fits one service
  exactly — and there's no headroom, so don't run a second free service on the
  same account.

   pingers that need no card: **cron-job.org** (1 min interval) or
   **uptimerobot.com** (5 min interval, 50 monitors free).

### deploy

```powershell
# once, in this folder
git remote add origin https://github.com/<you>/anime-bench.git   # create an EMPTY private repo first
git branch -M main
git push -u origin main
```

then:

1. render dashboard → **New → Blueprint** → connect github → pick the repo.
   it reads `render.yaml`: docker, free plan, healthcheck `/api/health`,
   `TRUST_PROXY=1` so rate limits key the visitor's ip.
2. **Environment** → add `ACCESS_CODE` = something only you know. the url becomes
   `https://<name>.onrender.com/?k=<code>` once per device.
3. set the pinger to `https://<name>.onrender.com/api/health` if you want 24/7.
4. open `#/share` — it detects it's hosted and shows the public link + qr.

### after deploying, check

```bash
curl -s https://your-site/api/health            # {"ok":true,...}
curl -s https://your-site/api/a4/home | head -c 120
```

---

## option 2 — oracle cloud always free (a real server, never sleeps)

genuinely free forever, but **a card is required for identity verification**
(not charged). 2 arm cores / 12 GB, 10 TB egress.

1. create an **Always Free** VM (ubuntu 22.04, arm).
2. open ingress for 80/443 (not 8787 — caddy terminates tls).
3. on the box:

   ```bash
   sudo apt update && sudo apt install -y git caddy
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   git clone <your repo> /opt/anime-bench && cd /opt/anime-bench
   npm ci --omit=dev
   sudo cp deploy/anime-bench.service /etc/systemd/system/
   sudo systemctl enable --now anime-bench
   sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
   sudo systemctl reload caddy
   ```

4. point a domain at the vm (or use `sslip.io`: `anime.80-12-34-56.sslip.io` —
   no domain purchase, still gets https).

this is the only option with no hours cap and no cold starts.

---

## option 3 — a spare box at home

a raspberry pi or an old laptop running `npm start`, always on, €0. reach it
from outside with **tailscale** (private) or a **cloudflared tunnel** (public
url, no account). see `#/share` in the app.

---

## free tiers that used to work (2026)

- **hugging face spaces** — docker/gradio spaces now need a paid plan (PRO).
  only static spaces are free, and this app needs a server.
- **koyeb** — free hobby plan closed; a card + $29 hold is required.
- **fly.io** — free allowances retired in 2024.
- **heroku / glitch / cyclic** — gone.
- **railway** — trial only, $1 credit/month after.

---

## env vars the server understands

| var | default | what it does |
|---|---|---|
| `PORT` | `8787` | listen port (hosts inject this) |
| `HOST` | `0.0.0.0` | bind address |
| `TRUST_PROXY` | — | set `1` behind render/cloudflare so rate limits use the visitor ip |
| `ACCESS_CODE` | — | require `?k=<code>` once per device |
| `CACHE_MAX` | `3000` | entries kept in ram; lower it on a 512 MB host |
| `CACHE_*_MS` | 5–30 min | ttl for sources/detail/episodes/trending |

---

## two gotchas

- **cold starts**: without a pinger the first click after 15 min idle takes ~40 s.
- **free tiers can vanish.** the repo is self-contained (docker + one process),
  so moving host is a `git push` away.
- **content complaints**: a public copy of a pirate mirror on shared infra can be
  reported and taken down. keep it private (`ACCESS_CODE`) and small.
