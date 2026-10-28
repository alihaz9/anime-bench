# run anime bench without your pc (free)

your pc is doing two jobs: scraping anime4up/anilist, and proxying the video
(it sends `referer` headers the cdns demand, so phones can play). "works while
my pc is off" means moving those two jobs onto a machine that never sleeps.
nothing here needs a database — the whole app is stateless, so it drops onto a
free host as-is.

## the real constraint is bandwidth, not cpu

every episode is streamed *through* the server:

| quality | size per ~24 min episode |
|---|---|
| 360p | ~150–250 MB |
| 720p | ~350–500 MB |
| 1080p | ~600–1000 MB |

so a 100 GB/month allowance ≈ **100–200 episodes**. that's plenty for a few
people, not enough for a public site. if you want "me + friends", any option
below works; if you want "the whole internet", it will hit a paywall fast.

---

## option 1 — render.com (easiest, 10 minutes)

free web service, https subdomain, no card needed. sleeps after ~15 min idle and
takes 30–60 s to wake, which is fine for a personal site.

1. push this folder to a **private** github repo (commands at the bottom).
2. render dashboard → **New → Blueprint** → pick the repo. it reads `render.yaml`
   and creates the service with the right env vars.
3. add `ACCESS_CODE` in the dashboard (Environment) if you don't want strangers
   using your key — the URL becomes `https://<name>.onrender.com/?k=<code>` once
   per device.
4. open the URL, then `#/share` still shows the LAN address for home use.

cost: $0. limits: 512 MB ram, ~100 GB egress/mo, sleeps when idle.

## option 2 — hugging face spaces (no card, more ram)

free docker space, 16 GB ram, sleeps only after ~48 h idle, and needs no billing
info at all. it is public by default and their terms apply — your call.

1. create a **Docker** space.
2. push this folder to the space's git remote.
3. in the space's `README.md` metadata set:
   ```yaml
   app_port: 7860
   ```
4. add a repository secret/env `PORT=7860` and `ACCESS_CODE=<something>`
   (dockerfile already honours both).

## option 3 — oracle cloud always free (a real server, best value)

the genuinely free-forever vps: 4 arm cores / 24 GB ram (or a small amd box),
10 TB egress per month, never sleeps. needs a card for identity verification
(not charged) and ~30 min of setup.

1. create an **Always Free** VM (ubuntu 22.04, arm ampere).
2. open ingress for 80/443 in the security list (not 8787 — caddy handles tls).
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
4. point a domain's A record at the VM's public ip (or use `sslip.io`, e.g.
   `anime.80-12-34-56.sslip.io` — no domain, still gets https).

cost: $0 forever. this is the only option with no bandwidth worry.

## option 4 — keep it at home, just not on your pc

a raspberry pi, an old laptop, or the router itself: same command
(`npm start`), always on, no monthly cost. you still need tailscale/cloudflared
to reach it from outside — see `#/share` in the app.

---

## make it deployable (once)

```powershell
git init
git add .
git commit -m "anime bench"
# create an empty PRIVATE repo on github, then:
git remote add origin https://github.com/<you>/anime-bench.git
git branch -M main
git push -u origin main
```

## env vars the server understands

| var | default | what it does |
|---|---|---|
| `PORT` | `8787` | listen port (hosts inject this) |
| `HOST` | `0.0.0.0` | bind address |
| `TRUST_PROXY` | — | set `1` behind render/cloudflare so rate limits use the visitor ip |
| `ACCESS_CODE` | — | require `?k=<code>` once per device |
| `CACHE_MAX` | `3000` | entries kept in ram; lower it on a 512 MB host |
| `CACHE_*_MS` | 5–30 min | ttl for sources/detail/episodes/trending |

## after deploying, check

```bash
curl -s https://your-site/api/health     # {"ok":true,...}
curl -s https://your-site/api/a4/home | head -c 120
```

## two gotchas

- **cold starts** on render mean the first click of the day takes ~40 s. the
  page shows skeletons, so it looks slow but isn't broken.
- **free tiers can vanish.** the repo is self-contained (docker + one process),
  so moving to another host is a `git push` away.
