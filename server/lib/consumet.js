// Episode resolution against a self-hosted Consumet instance.
const BASE = (process.env.CONSUMET_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const PROVIDER = process.env.CONSUMET_PROVIDER || 'gogoanime';
const TIMEOUT_MS = 12_000;

const safeId = (value) => /^[a-zA-Z0-9_-]{1,160}$/.test(String(value ?? ''));

function fail(message, status) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function call(pathname) {
  let res;
  try {
    res = await fetch(`${BASE}${pathname}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    fail('source service unreachable — check CONSUMET_BASE', 502);
  }
  if (res.status === 404) fail('episode source not found', 404);
  if (!res.ok) fail(`source service ${res.status}`, 502);
  try {
    return await res.json();
  } catch {
    fail('source service returned junk', 502);
  }
}

const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function similarity(a, b) {
  const left = new Set(normalize(a).split(' ').filter(Boolean));
  const right = new Set(normalize(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / Math.max(left.size, right.size);
}

function scoreCandidate(candidate, titles) {
  const haystack = [candidate.title, candidate.otherName].filter(Boolean);
  let best = 0;
  for (const title of titles) {
    for (const value of haystack) best = Math.max(best, similarity(title, value));
  }
  if (candidate.subOrDub === 'dub') best += 0.05;
  return best;
}

async function searchProvider(term) {
  const payload = await call(`/anime/${PROVIDER}/${encodeURIComponent(term)}`);
  return Array.isArray(payload?.results) ? payload.results : [];
}

async function pickProviderId(media, dub) {
  const titles = [media.title?.english, media.title?.romaji, media.title?.native].filter(Boolean);
  if (!titles.length) fail('anime has no usable title', 422);

  let best = null;
  for (const term of titles.slice(0, 2)) {
    let results;
    try {
      results = await searchProvider(term);
    } catch {
      continue;
    }
    for (const candidate of results) {
      if (dub && candidate.subOrDub === 'sub') continue;
      if (!dub && candidate.subOrDub === 'dub') continue;
      const score = scoreCandidate(candidate, titles);
      if (!best || score > best.score) best = { id: candidate.id, title: candidate.title, score };
    }
    if (best && best.score >= 0.75) break;
  }

  if (!best || best.score < 0.34) fail('no matching source for this anime', 404);
  return best;
}

export async function resolve(media, dub = false) {
  const picked = await pickProviderId(media, dub);
  const info = await call(`/anime/${PROVIDER}/info/${encodeURIComponent(picked.id)}`);
  const raw = Array.isArray(info?.episodes) ? info.episodes : [];
  const expected = Number.isFinite(media.episodes) && media.episodes > 0 ? media.episodes : null;

  const episodes = raw
    .map((ep) => ({
      id: String(ep.id ?? ''),
      number: Number(ep.number ?? 0),
      title: typeof ep.title === 'string' ? ep.title : '',
      isFiller: Boolean(ep.isFiller),
    }))
    .filter((ep) => safeId(ep.id) && Number.isFinite(ep.number) && ep.number > 0)
    .filter((ep) => (expected ? ep.number <= expected : true))
    .sort((a, b) => a.number - b.number);

  if (!episodes.length) fail('source returned no episodes', 404);

  return {
    providerId: picked.id,
    matched: picked.title,
    score: Number(picked.score.toFixed(2)),
    episodes,
  };
}

export async function sources(episodeId) {
  if (!safeId(episodeId)) fail('bad episode id', 400);
  const payload = await call(`/anime/${PROVIDER}/watch/${encodeURIComponent(episodeId)}`);
  const headers = payload?.headers && typeof payload.headers === 'object' ? payload.headers : {};

  const qualityRank = { '1080p': 4, '720p': 3, '480p': 2, '360p': 1, auto: 0, default: 0 };
  const seen = new Set();
  const list = (Array.isArray(payload?.sources) ? payload.sources : [])
    .filter((src) => src && typeof src.url === 'string' && /^https?:\/\//i.test(src.url))
    .filter((src) => {
      if (seen.has(src.url)) return false;
      seen.add(src.url);
      return true;
    })
    .map((src) => ({
      url: src.url,
      quality: String(src.quality ?? 'auto'),
      isM3U8: Boolean(src.isM3U8) || /\.m3u8(\?|$)/i.test(src.url),
    }))
    .sort((a, b) => (qualityRank[b.quality] ?? 0) - (qualityRank[a.quality] ?? 0));

  if (!list.length) fail('no playable source', 502);

  return {
    sources: list,
    referer: typeof headers.Referer === 'string' ? headers.Referer : '',
  };
}
