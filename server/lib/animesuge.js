// Animesuge (WordPress) source layer. Catalog by AniList title, playback via
// the provider's own watch page embedded in an iframe — no segment scraping.
const BASE = (process.env.ANIMESUGE_BASE || 'https://animesuge.lol').replace(/\/+$/, '');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 15_000;
const MAX_EPISODE_PAGES = 12;

const isSlug = (value) => /^[a-z0-9][a-z0-9-]{0,199}$/.test(String(value ?? ''));

function fail(message, status) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function wp(pathname) {
  let res;
  try {
    res = await fetch(`${BASE}/wp-json/wp/v2/${pathname}`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    fail('source site unreachable', 502);
  }
  if (res.status === 400) fail('source rejected the query', 400);
  if (!res.ok) fail(`source site ${res.status}`, 502);
  try {
    return { data: await res.json(), pages: Number(res.headers.get('x-wp-totalpages') || 1) };
  } catch {
    fail('source returned junk', 502);
  }
}

const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const stripSeason = (value) => normalize(value).replace(/\b(season|part|cour)\s*\d+\b/g, ' ').replace(/\s+/g, ' ').trim();

const seasonNumbers = (value) =>
  [...String(value ?? '').matchAll(/\b(?:season|part|cour)\s*(\d+)\b/gi)].map((m) => Number(m[1]));

function tokenStats(a, b) {
  const left = new Set(normalize(a).split(' ').filter(Boolean));
  const right = new Set(normalize(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  const overlap = shared / Math.max(left.size, right.size);
  const contained = shared / Math.min(left.size, right.size);
  return overlap * 0.6 + contained * 0.4;
}

function titleScore(candidate, title) {
  let score = tokenStats(candidate, title) * 0.8 + tokenStats(stripSeason(candidate), stripSeason(title)) * 0.2;

  const candidateSeasons = seasonNumbers(candidate);
  const titleSeasons = seasonNumbers(title);
  if (candidateSeasons.length && titleSeasons.length && !candidateSeasons.some((n) => titleSeasons.includes(n))) {
    score -= 0.25;
  } else if (candidateSeasons.length && !titleSeasons.length) {
    score -= 0.3;
  }
  return score;
}

function buildQueries(titles, dub) {
  const queries = [];
  const push = (value) => {
    const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (clean && clean.length >= 2 && !queries.includes(clean)) queries.push(clean);
  };

  for (const title of titles.slice(0, 2)) {
    if (dub) push(`${title} English Dub`);
    push(title);
    push(title.split(':')[0]);
    push(title.split(':')[0].replace(/\b(season|part|cour)\s*\d+\b/gi, ''));
    push(title.split(/[:–-]/)[0]);
  }

  return queries.slice(0, 6);
}

async function findSeries(media, dub) {
  const titles = [media.title?.english, media.title?.romaji, media.title?.native].filter(Boolean);
  if (!titles.length) fail('anime has no usable title', 422);

  const queries = buildQueries(titles, dub);
  let best = null;

  for (const query of queries) {
    let data;
    try {
      ({ data } = await wp(`anime?search=${encodeURIComponent(query)}&per_page=10&_fields=id,slug,title,link`));
    } catch {
      continue;
    }

    for (const post of Array.isArray(data) ? data : []) {
      if (!isSlug(post.slug)) continue;
      const name = typeof post.title?.rendered === 'string' ? post.title.rendered : post.title;
      let score = Math.max(
        titleScore(name, titles[0]),
        titles[1] ? titleScore(name, titles[1]) * 0.95 : 0,
      );
      if (dub && /dub/i.test(`${name} ${post.slug}`)) score += 0.1;
      const movieLike = /movie|film/i.test(`${name} ${post.slug}`);
      if (media.format === 'MOVIE') score += movieLike ? 0.15 : -0.2;
      if (!best || score > best.score) {
        best = { slug: post.slug, title: name, score, dub: /dub/i.test(post.slug), movieLike };
      }
    }

    if (best && best.score >= 0.95) break;
  }

  if (!best || best.score < 0.4) fail('no matching source for this anime', 404);
  // a TV shelf is the wrong answer for a film: better to say we don't have it
  if (media.format === 'MOVIE' && !best.movieLike) fail('source has no copy of this movie', 404);
  return best;
}

function parseEpisodeSlug(slug, prefix) {
  const tail = slug.slice(prefix.length);
  const match = tail.match(/^episode-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  const suffix = match[2] ?? '';
  const track = /^(d|dub|eng|english)$/i.test(suffix) ? 'dub' : 'sub';
  return { number, track };
}

async function seriesPageSlugs(series) {
  let html;
  try {
    const res = await fetch(`${BASE}/anime/${series.slug}/`, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  }

  const slugs = new Set();
  const pattern = /\/watch\/([a-z0-9][a-z0-9-]*?)\/?["'?]/gi;
  let match;
  while ((match = pattern.exec(html))) slugs.add(match[1]);
  return [...slugs];
}

async function searchEpisodeSlugs(series) {
  const slugs = new Set();
  for (let page = 1; page <= MAX_EPISODE_PAGES; page++) {
    let data;
    let pages;
    try {
      ({ data, pages } = await wp(
        `episode?search=${encodeURIComponent(series.title)}&per_page=100&page=${page}&orderby=date&order=desc&_fields=slug`,
      ));
    } catch {
      break;
    }
    for (const post of Array.isArray(data) ? data : []) {
      if (typeof post.slug === 'string') slugs.add(post.slug);
    }
    if (page >= pages || data.length === 0) break;
  }
  return [...slugs];
}

async function listEpisodes(series, dub) {
  // series slugs sometimes carry a single-letter disambiguator ("one-piece-a")
  const prefix = `${series.slug.replace(/-[a-z]$/i, '')}-`;
  const candidates = new Set([
    ...(await seriesPageSlugs(series)),
    ...(await searchEpisodeSlugs(series)),
  ]);

  const byNumber = new Map();
  for (const slug of candidates) {
    if (!slug.startsWith(prefix)) continue;
    const parsed = parseEpisodeSlug(slug, prefix);
    if (!parsed) continue;
    const slot = byNumber.get(parsed.number) ?? {};
    slot[parsed.track] = slug;
    byNumber.set(parsed.number, slot);
  }

  const episodes = [];
  for (const [number, slot] of byNumber) {
    const slug = dub ? slot.dub ?? slot.sub : slot.sub ?? slot.dub;
    if (!slug) continue;
    episodes.push({
      id: `as:${slug}`,
      number,
      title: '',
      track: slug === slot.dub ? 'dub' : 'sub',
      provider: 'animesuge',
    });
  }

  return episodes.sort((a, b) => a.number - b.number);
}

export async function resolve(media, dub = false) {
  const series = await findSeries(media, dub);
  const episodes = await listEpisodes(series, dub);
  if (!episodes.length) fail('source has no episodes for this title', 404);

  const expected = Number.isFinite(media.episodes) && media.episodes > 0 ? media.episodes : null;
  const filtered = expected ? episodes.filter((ep) => ep.number <= expected) : episodes;

  return {
    provider: 'animesuge',
    matched: series.title,
    dub: series.dub || episodes.some((ep) => ep.track === 'dub'),
    episodes: filtered.length ? filtered : episodes,
  };
}

const VIDEO_FILE = /\.(mp4|webm|m3u8|mpd)(?:[?#]|$)/i;

function playerFromPage(html) {
  const tag = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (!tag) return null;
  const raw = tag[1].trim();
  if (!raw || raw.startsWith('about:')) return null;
  return raw.startsWith('//') ? `https:${raw}` : raw;
}

async function playerAlive(url) {
  try {
    const res = await fetch(url, {
      headers: {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        referer: `${BASE}/`,
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return false;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    return /video\/|text\/html|application\/(javascript|octet-stream|x-mpegurl)/.test(type);
  } catch {
    return false;
  }
}

export async function watch(slug) {
  if (!isSlug(slug)) fail('bad episode id', 400);

  let html;
  try {
    const res = await fetch(`${BASE}/watch/${slug}/`, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) fail('no such episode on the source', 404);
    if (!res.ok) fail(`source site ${res.status}`, 502);
    html = await res.text();
  } catch (error) {
    if (error.status) throw error;
    fail('source site unreachable', 502);
  }

  const player = playerFromPage(html);
  if (!player) fail('source exposes no player for this episode', 404);

  // most episodes point straight at a video file the browser can play natively
  if (VIDEO_FILE.test(player)) {
    return {
      provider: 'animesuge',
      referer: `${BASE}/`,
      sources: [
        {
          url: player,
          quality: 'auto',
          isM3U8: /\.m3u8(?:[?#]|$)/i.test(player),
          isEmbed: false,
        },
      ],
    };
  }

  // the rest sit behind a small player page: frame it only if it still resolves
  if (!(await playerAlive(player))) fail('the source player for this episode is offline', 404);

  return {
    provider: 'animesuge',
    referer: `${BASE}/`,
    sources: [
      {
        url: player,
        quality: 'source',
        isM3U8: false,
        isEmbed: true,
      },
    ],
  };
}
