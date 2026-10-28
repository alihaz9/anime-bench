import express from 'express';
import compression from 'compression';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cache } from './lib/cache.js';
import * as anilist from './lib/anilist.js';
import * as sources from './lib/consumet.js';
import * as animesuge from './lib/animesuge.js';
import * as anime4up from './lib/anime4up.js';
import { streamProxy } from './lib/proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 8787);
// 0.0.0.0 = answer on the LAN too, not just this machine's loopback
const HOST = process.env.HOST || '0.0.0.0';
// optional: set ACCESS_CODE=xxxx before `npm start` when the site is exposed
// outside the house (tunnel/port-forward), so strangers can't use your scraper
const ACCESS_CODE = String(process.env.ACCESS_CODE || '').trim();

function lanAddresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      found.push(entry.address);
    }
  }
  return found;
}

const TTL = {
  trending: Number(process.env.CACHE_TRENDING_MS || 10 * 60_000),
  detail: Number(process.env.CACHE_DETAIL_MS || 30 * 60_000),
  episodes: Number(process.env.CACHE_EPISODES_MS || 30 * 60_000),
  sources: Number(process.env.CACHE_SOURCES_MS || 5 * 60_000),
};

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(compression());
app.use(express.json({ limit: '16kb' }));

// ---- optional access code --------------------------------------------------
// only active when ACCESS_CODE is set; keeps a tunnel/port-forward private.
function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

if (ACCESS_CODE) {
  app.use((req, res, next) => {
    const given = String(req.query.k || readCookie(req.headers.cookie, 'ab_key') || '');
    if (given === ACCESS_CODE) {
      if (req.query.k) {
        res.setHeader(
          'set-cookie',
          `ab_key=${encodeURIComponent(ACCESS_CODE)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        );
      }
      return next();
    }

    res
      .status(401)
      .type('html')
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>anime bench — code</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b12;color:#eee;font:16px system-ui}
form{background:#15151f;padding:26px;border-radius:16px;display:grid;gap:12px;min-width:260px}
input{background:#0b0b12;border:1px solid #2a2a3a;color:#eee;border-radius:10px;padding:12px;font-size:16px}
button{background:#ff4d6d;color:#fff;border:0;border-radius:10px;padding:12px;font-size:16px;cursor:pointer}</style>
<form method="get"><strong>enter the access code</strong>
<input name="k" autofocus autocomplete="off" inputmode="text" aria-label="access code">
<button>open anime bench</button></form>`);
  });
}

const cache = new Cache({ max: Number(process.env.CACHE_MAX || 3000) });

// ---- rate limit ------------------------------------------------------------
// one bucket per ip *per route*: a page full of poster images rides
// /api/stream, and that traffic must never eat the budget for /api/home.
// responses served from the in-memory cache are refunded — they never touch
// the far side, so they cannot be what melts the site.
const buckets = new Map();
const BUCKET_SWEEP = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.reset <= now) buckets.delete(key);
}, 60_000);
BUCKET_SWEEP.unref?.();

function limit(scope, max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${ip}|${scope}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.set(key, bucket);
    }

    if (bucket.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
      res.set('retry-after', String(retryAfter));
      return res.status(429).json({ error: 'too many requests', retryAfter });
    }

    bucket.count += 1;
    res.on('finish', () => {
      if (res.locals?.cacheHit) bucket.count = Math.max(0, bucket.count - 1);
    });
    next();
  };
}

const cacheHit = (res) => {
  res.locals.cacheHit = true;
  return res;
};

const wrap = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

// ---- api -------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

// where this server can be reached from other devices
const isPrivateHost = (host) =>
  host === 'localhost' ||
  host === '127.0.0.1' ||
  host === '::1' ||
  /^10\./.test(host) ||
  /^192\.168\./.test(host) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
  host.endsWith('.local');

app.get(
  '/api/net',
  limit('net', 60, 60_000),
  wrap(async (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    // only local installs get lan addresses — on render/cloudflare those
    // interfaces are container-internal and useless to a phone
    const urls = isPrivateHost(String(req.hostname || ''))
      ? lanAddresses().map((ip) => `http://${ip}:${PORT}`)
      : [];
    const target = urls[0] || origin;

    let qr = '';
    try {
      const QRCode = (await import('qrcode')).default;
      qr = await QRCode.toString(target, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' });
    } catch {
      qr = '';
    }

    res.json({ port: PORT, urls, origin, hosted: !urls.length, needsCode: Boolean(ACCESS_CODE), qr });
  }),
);

app.get(
  '/api/home',
  limit('home', 120, 60_000),
  wrap(async (_req, res) => {
    const hit = cache.get('home');
    if (hit) return cacheHit(res).json(hit);

    const [trending, season] = await Promise.all([anilist.trending(1), anilist.season(1)]);
    const payload = { hero: trending[0] ?? null, trending, season };
    cache.set('home', payload, TTL.trending);
    res.json(payload);
  }),
);

app.get(
  '/api/search',
  limit('search', 60, 60_000),
  wrap(async (req, res) => {
    const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (term.length < 2) return res.status(400).json({ error: 'query too short' });

    const key = `search:${term.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit) return cacheHit(res).json({ query: term, results: hit });

    const results = await anilist.search(term);
    cache.set(key, results, TTL.trending);
    res.json({ query: term, results });
  }),
);

app.get(
  '/api/anime/:id',
  limit('anime', 240, 60_000),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });

    const key = `anime:${id}`;
    const hit = cache.get(key);
    if (hit) return cacheHit(res).json(hit);

    const media = await anilist.detail(id);
    cache.set(key, media, TTL.detail);
    res.json(media);
  }),
);

app.get(
  '/api/episodes/:id',
  limit('episodes', 180, 60_000),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });

    const lang = req.query.lang === 'ar' ? 'ar' : req.query.dub === '1' ? 'dub' : 'sub';
    const key = `episodes:${id}:${lang}`;
    const hit = cache.get(key);
    if (hit) return cacheHit(res).json(hit);

    const media = await anilist.detail(id);

    let payload = null;
    if (lang === 'ar') {
      try {
        payload = await anime4up.resolve(media);
      } catch {
        payload = null;
      }
    }

    if (!payload) {
      const dub = lang === 'dub';
      try {
        payload = await animesuge.resolve(media, dub);
      } catch (primaryError) {
        try {
          const resolved = await sources.resolve(media, dub);
          payload = {
            provider: 'consumet',
            providerId: resolved.providerId,
            matched: resolved.matched,
            dub,
            episodes: resolved.episodes,
          };
        } catch {
          throw primaryError;
        }
      }
    }

    cache.set(key, payload, TTL.episodes);
    res.json(payload);
  }),
);

app.get(
  '/api/watch/:episodeId',
  limit('watch', 200, 60_000),
  wrap(async (req, res) => {
    const episodeId = String(req.params.episodeId || '');
    if (!/^[a-zA-Z0-9:_-]{1,220}$/.test(episodeId)) {
      return res.status(400).json({ error: 'bad episode id' });
    }

    const key = `watch:${episodeId}`;
    const hit = cache.get(key);
    if (hit) return cacheHit(res).json(hit);

    if (episodeId.startsWith('a4:')) {
      const slug = anime4up.decodeId(episodeId.slice(3));
      const payload = await anime4up.watch(slug);
      cache.set(key, payload, 90_000);
      return res.json(payload);
    }

    if (episodeId.startsWith('as:')) {
      const payload = await animesuge.watch(episodeId.slice(3));
      cache.set(key, payload, TTL.sources);
      return res.json(payload);
    }

    const data = await sources.sources(episodeId);
    const payload = {
      referer: data.referer,
      sources: data.sources.map((source) => ({
        ...source,
        proxy: `/api/stream?url=${encodeURIComponent(source.url)}${
          data.referer ? `&ref=${encodeURIComponent(data.referer)}` : ''
        }`,
      })),
    };
    cache.set(key, payload, TTL.sources);
    res.json(payload);
  }),
);

app.get(
  '/api/a4/home',
  limit('a4:home', 120, 60_000),
  wrap(async (_req, res) => {
    const hit = cache.get('a4:home');
    if (hit) return cacheHit(res).json(hit);

    const latest = await anime4up.latest();
    const payload = { provider: 'anime4up', latest };
    cache.set('a4:home', payload, TTL.trending);
    res.json(payload);
  }),
);

app.get(
  '/api/a4/search',
  limit('a4:search', 60, 60_000),
  wrap(async (req, res) => {
    const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (term.length < 2) return res.status(400).json({ error: 'query too short' });

    const key = `a4:search:${term.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit) return cacheHit(res).json({ query: term, results: hit });

    const results = await anime4up.search(term);
    cache.set(key, results, TTL.trending);
    res.json({ query: term, results });
  }),
);

app.get(
  '/api/a4/series/:slug',
  limit('a4:series', 150, 60_000),
  wrap(async (req, res) => {
    const slug = String(req.params.slug || '');
    const key = `a4:series:${slug}`;
    const hit = cache.get(key);
    if (hit) return cacheHit(res).json(hit);

    const payload = await anime4up.series(slug);
    cache.set(key, payload, TTL.episodes);
    res.json(payload);
  }),
);

app.get(
  '/api/a4/browse',
  limit('a4:browse', 120, 60_000),
  wrap(async (req, res) => {
    const page = Math.max(1, Math.min(118, Number(req.query.page) || 1));
    const key = `a4:browse:${page}`;
    const hit = cache.get(key);
    if (hit) return cacheHit(res).json(hit);

    const payload = await anime4up.browse(page);
    cache.set(key, payload, TTL.episodes);
    res.json(payload);
  }),
);

app.get('/api/stream', limit('stream', 1200, 60_000), wrap(streamProxy));

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

// ---- static ----------------------------------------------------------------
app.use(
  express.static(WEB_DIR, {
    extensions: ['html'],
    etag: true,
    maxAge: 0,
    setHeaders: (res) => res.setHeader('cache-control', 'no-cache'),
  }),
);
app.get('*', (_req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));

// ---- errors ----------------------------------------------------------------
app.use((err, _req, res, _next) => {
  const status = Number(err?.status) || 500;
  const message = err?.status ? err.message || 'request failed' : status >= 500 ? 'internal error' : err.message || 'request failed';
  if (!err?.status && status >= 500) console.error('[anime-bench]', err);
  res.status(status).json({ error: message });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`anime-bench listening on http://localhost:${PORT}`);

  const lan = lanAddresses();
  if (lan.length && HOST === '0.0.0.0') {
    console.log('same wifi / other devices:');
    for (const ip of lan) console.log(`  http://${ip}:${PORT}`);
  }
  if (ACCESS_CODE) {
    console.log(`access code is on — links need ?k=<code> once per device`);
  }
});

function shutdown(signal) {
  console.log(`\n[anime-bench] ${signal} — closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
