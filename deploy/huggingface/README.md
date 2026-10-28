---
title: anime bench
emoji: 🍥
colorFrom: pink
colorTo: indigo
sdk: docker
app_port: 8787
pinned: false
license: mit
short_description: anime bench — anilist metadata, animesuge + anime4up playback
---

# anime bench

Free CPU-basic space. Node container, no database, no keys.
Video bytes never touch this container: the browser plays the cdn url directly
and only falls back to `/api/stream` when the cdn refuses the referer.

Health: `/api/health` — this is what the keepalive pings.
