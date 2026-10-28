// Anime4Up (Arabic WordPress theme) source layer. Series lookup by AniList
// title, episode list from the site's own pager, playback from its vnx player
// — japanese audio with a real arabic .vtt — and the hardsub embeds as a
// fallback when the softsub player is down.
const BASE = (process.env.ANIME4UP_BASE || 'https://w1.anime4up.rest').replace(/\/+$/, '');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 20_000;
const MAX_PAGES = 30;
const PAGE_CONCURRENCY = 4;
const MAX_SERVER_TRIES = 4;

const isSeriesSlug = (value) => /^[a-z0-9][a-z0-9-]{1,199}$/.test(String(value ?? ''));

function fail(message, status) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function fetchText(url, { referer = `${BASE}/`, accept = 'text/html,application/xhtml+xml' } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept,
        'accept-language': 'ar,en;q=0.8',
        referer,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    fail('source site unreachable', 502);
  }
  if (res.status === 404) fail('no such title on the source', 404);
  if (!res.ok) fail(`source site ${res.status}`, 502);
  try {
    return await res.text();
  } catch {
    fail('source returned junk', 502);
  }
}

const decodeEntities = (value) =>
  String(value ?? '')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();

const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim();

const slugWords = (slug) => normalize(String(slug).replace(/-/g, ' '));

const stripSeason = (value) =>
  normalize(value)
    .replace(/\b(season|part|cour)\s*\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const seasonNumbers = (value) =>
  [...String(value ?? '').matchAll(/\b(?:season|part|cour)\s*(\d+)\b/gi)].map((m) => Number(m[1]));

function tokenStats(a, b) {
  const left = new Set(normalize(a).split(' ').filter(Boolean));
  const right = new Set(normalize(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return (shared / Math.max(left.size, right.size)) * 0.6 + (shared / Math.min(left.size, right.size)) * 0.4;
}

function seriesScore(slug, title, format) {
  const words = slugWords(slug);
  let score = tokenStats(words, title) * 0.8 + tokenStats(stripSeason(words), stripSeason(title)) * 0.2;

  const slugSeasons = seasonNumbers(words);
  const titleSeasons = seasonNumbers(title);
  if (slugSeasons.length && titleSeasons.length && !slugSeasons.some((n) => titleSeasons.includes(n))) {
    score -= 0.25;
  } else if (slugSeasons.length && !titleSeasons.length) {
    score -= 0.3;
  }

  // a film page under a TV title is the wrong shelf, and vice versa
  const movieLike = /(movie|film|فيلم)/i.test(slug) || /(^|-)0(-|$)/.test(slug);
  if (format === 'MOVIE') {
    score += movieLike ? 0.15 : -0.2;
  } else if (movieLike) {
    score -= 0.25;
  }
  return score;
}

function buildQueries(titles) {
  const queries = [];
  const push = (value) => {
    const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (clean.length >= 2 && !queries.includes(clean)) queries.push(clean);
  };
  for (const title of titles.slice(0, 3)) {
    push(title);
    push(title.split(':')[0]);
    push(title.split(/[:–-]/)[0]);
    push(title.split(':')[0].replace(/\b(season|part|cour)\s*\d+\b/gi, ''));
  }
  return queries.slice(0, 7);
}

const CARD_SLUG = /href="https?:\/\/[^"]*\/anime\/([a-z0-9][a-z0-9-]*)\/"/g;

function slugsFromSearch(html) {
  const slugs = [];
  const seen = new Set();
  CARD_SLUG.lastIndex = 0;
  let match;
  while ((match = CARD_SLUG.exec(html))) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    slugs.push(match[1]);
  }
  return slugs;
}

export async function findSeries(media) {
  const titles = [media.title?.romaji, media.title?.english, media.title?.native].filter(Boolean);
  if (!titles.length) fail('anime has no usable title', 422);

  let best = null;
  for (const query of buildQueries(titles)) {
    let html;
    try {
      html = await fetchText(`${BASE}/?s=${encodeURIComponent(query)}`);
    } catch {
      continue;
    }
    for (const slug of slugsFromSearch(html)) {
      let score = 0;
      for (const title of titles) score = Math.max(score, seriesScore(slug, title, media.format));
      if (!best || score > best.score) best = { slug, score };
    }
    if (best && best.score >= 0.92) break;
  }

  if (!best || best.score < 0.4) fail('no matching source for this anime', 404);
  return { slug: best.slug, score: Number(best.score.toFixed(2)) };
}

const EPISODE_ANCHOR = /<a\b[^>]*href="((?:https?:\/\/[^"]*)?\/episode\/[^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/g;
const ARABIC_NUMBER = /الحلق(?:ة|ه)[-\s]*(\d+(?:\.\d+)?)/;
const stripTags = (value) =>
  String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

// series slugs carry a random suffix ("naruto-uef", "black-clover-fgh"); the
// episode links are matched by their arabic episode label instead of the slug.
function episodesFromPage(html) {
  const found = new Map();
  let match;
  EPISODE_ANCHOR.lastIndex = 0;
  while ((match = EPISODE_ANCHOR.exec(html))) {
    let slug;
    try {
      slug = decodeURIComponent(match[1].replace(/^https?:\/\/[^/]+\//, ''));
    } catch {
      continue;
    }
    slug = slug.replace(/^\/?episode\//, '').replace(/\/+$/, '');
    if (slug.length < 4 || slug.length > 400) continue;

    const label = stripTags(match[2]);
    const looksLikeEpisode =
      ARABIC_NUMBER.test(label) || ARABIC_NUMBER.test(slug) || /فيلم|movie|film/i.test(slug);
    if (!looksLikeEpisode) continue;

    let number = Number(label.match(ARABIC_NUMBER)?.[1]);
    if (!Number.isFinite(number) || number <= 0) number = Number(slug.match(ARABIC_NUMBER)?.[1]);
    if ((!Number.isFinite(number) || number <= 0) && /فيلم|movie/i.test(slug)) number = 1;
    if (!Number.isFinite(number) || number <= 0) continue;
    if (!found.has(number)) found.set(number, slug);
  }
  return found;
}

async function seriesEpisodes(seriesSlug) {
  const first = await fetchText(`${BASE}/anime/${seriesSlug}/`);
  const collected = episodesFromPage(first);

  const declared = [...first.matchAll(/\/anime\/[a-z0-9-]+\/page\/(\d+)\//g)].map((m) => Number(m[1]));
  const lastPage = Math.min(MAX_PAGES, Math.max(1, ...declared, 1));

  if (lastPage > 1) {
    const pages = [];
    for (let page = 2; page <= lastPage; page++) pages.push(page);

    let cursor = 0;
    const worker = async () => {
      while (cursor < pages.length) {
        const page = pages[cursor++];
        let html;
        try {
          html = await fetchText(`${BASE}/anime/${seriesSlug}/page/${page}/`);
        } catch {
          continue;
        }
        for (const [number, slug] of episodesFromPage(html)) {
          if (!collected.has(number)) collected.set(number, slug);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, pages.length) }, worker));
  }

  return collected;
}

const encodeId = (slug) => Buffer.from(slug, 'utf8').toString('base64url');
export const decodeId = (token) => Buffer.from(String(token ?? ''), 'base64url').toString('utf8');

export function validEpisodeId(slug) {
  const value = String(slug ?? '');
  if (value.length < 4 || value.length > 400) return false;
  if (/[\u0000-\u001f/\\?#]/.test(value)) return false;
  if (value.startsWith('.')) return false;
  return ARABIC_NUMBER.test(value) || /episode[- ]?\d+/i.test(value);
}

export async function resolve(media) {
  const series = await findSeries(media);
  const found = await seriesEpisodes(series.slug);
  if (!found.size) fail('source has no episodes for this title', 404);

  const expected = Number.isFinite(media.episodes) && media.episodes > 0 ? media.episodes : null;
  const episodes = [...found.entries()]
    .map(([number, slug]) => ({
      id: `a4:${encodeId(slug)}`,
      number,
      title: '',
      track: 'sub',
      audio: 'ja',
      subs: 'ar',
      provider: 'anime4up',
    }))
    .filter((ep) => (expected ? ep.number <= expected : true))
    .sort((a, b) => a.number - b.number);

  if (!episodes.length) fail('source has no episodes for this title', 404);

  return {
    provider: 'anime4up',
    providerId: series.slug,
    matched: series.slug,
    score: series.score,
    audio: 'ja',
    subtitles: 'ar',
    episodes,
  };
}

// ---- watch -----------------------------------------------------------------

const SERVER_ITEM = /<li[^>]*data-watch="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g;

function parseServers(html) {
  const servers = [];
  const seen = new Set();
  SERVER_ITEM.lastIndex = 0;
  let match;
  while ((match = SERVER_ITEM.exec(html))) {
    const url = decodeEntities(match[1]);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const name = decodeEntities(match[2].match(/watch-server-name[^>]*>([^<]+)</)?.[1] || '');
    const label = decodeEntities(match[2].match(/class="quality"[^>]*>([^<]+)</)?.[1] || '');
    servers.push({
      url,
      name: name || 'server',
      label: label || '',
      featured: /watch-server-featured/.test(match[0]),
      softsub: /anime4up-s\d/i.test(url) || /^https?:\/\/(?:4n|w\d+)\./i.test(url),
    });
  }
  return servers;
}

const proxyLink = (url, referer = `${BASE}/`) =>
  `/api/stream?url=${encodeURIComponent(url)}&ref=${encodeURIComponent(referer)}`;

function parseJsonLiteral(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parsePlayer(html) {
  const streamUrl = decodeEntities(
    html.match(/(?:let|const|var)\s+streamUrl\s*=\s*["']([^"']+)["']/)?.[1] || '',
  );
  if (!/^https?:\/\//i.test(streamUrl)) return null;

  const tracks = parseJsonLiteral(
    html.match(/(?:let|const|var)\s+tracks\s*=\s*(\[[\s\S]*?\}\s*\])\s*;/)?.[1],
  );
  const skip = parseJsonLiteral(
    html.match(/(?:let|const|var)\s+skipSegments\s*=\s*(\{[\s\S]*?\})\s*;/)?.[1],
  );

  const subtitles = (Array.isArray(tracks) ? tracks : [])
    .filter((track) => track && typeof track.file === 'string' && /^https?:\/\//i.test(track.file))
    .map((track) => ({
      url: proxyLink(track.file),
      lang: String(track.srclang || 'ar')
        .toLowerCase()
        .slice(0, 8),
      label: String(track.label || 'العربية'),
      default: Boolean(track.default),
    }));

  return {
    streamUrl,
    subtitles,
    skip: skip && typeof skip === 'object' ? skip : null,
  };
}

async function playerFor(server) {
  const html = await fetchText(server.url, { referer: `${BASE}/` });
  return parsePlayer(html);
}

// master playlist -> real quality rungs (1080p/720p/…). each rung is handed to
// the browser as a direct CDN url (the cdn sends `access-control-allow-origin: *`
// and does not check referer), with the server proxy kept as a fallback so a
// free host never pays for video bytes.
async function variantsOf(streamUrl) {
  const fallback = [{ quality: 'auto', url: streamUrl, proxy: proxyLink(streamUrl), isM3U8: true }];
  let text;
  try {
    const res = await fetch(streamUrl, {
      headers: { 'user-agent': USER_AGENT, accept: '*/*', referer: `${BASE}/` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return fallback;
    text = await res.text();
  } catch {
    return fallback;
  }
  if (!/^#EXTM3U/i.test(text.trim())) return fallback;

  const lines = text.split(/\r?\n/);
  const rungs = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const height = Number(line.match(/RESOLUTION=\d+x(\d+)/)?.[1] || 0);
    const bandwidth = Number(line.match(/BANDWIDTH=(\d+)/)?.[1] || 0);
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next || next.startsWith('#')) continue;
      uri = next;
      break;
    }
    if (!/^https?:\/\//i.test(uri)) continue;
    rungs.push({
      quality: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)}k` : 'auto',
      height,
      bandwidth,
      url: uri,
      proxy: proxyLink(uri),
      isM3U8: true,
    });
  }

  if (!rungs.length) return fallback;
  rungs.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  return rungs.map(({ quality, url, proxy, isM3U8 }) => ({ quality, url, proxy, isM3U8 }));
}

const firstSeriesSlug = (html) => html.match(/\/anime\/([a-z0-9][a-z0-9-]{1,199})\//)?.[1] || '';
const ogTitle = (html) => decodeEntities(html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] || '');
const ogImage = (html) => decodeEntities(html.match(/<meta property="og:image" content="([^"]*)"/)?.[1] || '');
const ogDescription = (html) =>
  decodeEntities(html.match(/<meta property="og:description" content="([^"]*)"/)?.[1] || '');
const displayTitle = (title) => String(title || '').replace(/\s*[-–]\s*Anime4up\s*$/i, '').trim();

export async function watch(slug) {
  if (!validEpisodeId(slug)) fail('bad episode id', 400);

  let page;
  try {
    page = await fetchText(`${BASE}/episode/${encodeURIComponent(slug)}/`);
  } catch (error) {
    if (error.status) throw error;
    fail('source site unreachable', 502);
  }

  const servers = parseServers(page);
  if (!servers.length) fail('source exposes no servers for this episode', 404);

  const fullTitle = displayTitle(ogTitle(page));
  const meta = {
    title: fullTitle.replace(/\s*الحلق(?:ة|ه)[-\s]*\d+(?:\.\d+)?\s*مترجمة?.*$/i, '').trim() || fullTitle,
    fullTitle,
    poster: ogImage(page),
    description: ogDescription(page),
    seriesSlug: firstSeriesSlug(page),
    number: episodeNumber(slug, fullTitle),
  };

  const ranked = [...servers].sort(
    (a, b) => Number(b.softsub) - Number(a.softsub) || Number(b.featured) - Number(a.featured),
  );

  // every server the page offers, each with its own quality rungs when the
  // stream is one we can unpack; embeds stay as they are.
  const resolved = [];
  let softsubTries = 0;

  for (const server of ranked) {
    if (server.softsub && softsubTries < MAX_SERVER_TRIES) {
      softsubTries += 1;
      let player = null;
      try {
        player = await playerFor(server);
      } catch {
        player = null;
      }
      if (player) {
        resolved.push({
          name: server.name,
          label: server.label,
          softsub: true,
          subtitles: player.subtitles,
          skip: player.skip,
          sources: await variantsOf(player.streamUrl),
        });
        continue;
      }
    }

    resolved.push({
      name: server.name,
      label: server.label,
      softsub: false,
      subtitles: [],
      skip: null,
      sources: [
        {
          url: server.url,
          quality: server.label || 'auto',
          isM3U8: false,
          isEmbed: true,
        },
      ],
    });
  }

  const primary = resolved.find((server) => server.softsub && server.sources.length) || resolved[0];

  return {
    provider: 'anime4up',
    server: primary.name,
    referer: `${BASE}/`,
    audio: 'ja',
    meta,
    servers: resolved,
    sources: primary.sources,
    subtitles: primary.subtitles,
    skip: primary.skip,
  };
}

// ---- catalog ---------------------------------------------------------------

const EPISODE_ID = (slug) => `a4:${encodeId(slug)}`;
const episodeNumber = (slug, label) => {
  const number = Number(stripTags(label).match(ARABIC_NUMBER)?.[1] ?? slug.match(ARABIC_NUMBER)?.[1]);
  return Number.isFinite(number) && number > 0 ? number : 1;
};

// newest uploads across the whole site
// both home and search render the same `.anime-card-themex` block: poster img,
// episode link, series link, title attribute. split on the class and read each.
function parseCards(html) {
  const chunks = String(html).split('anime-card-themex').slice(1);
  const cards = [];

  for (const raw of chunks) {
    const chunk = raw.slice(0, 4000);
    const img = chunk.match(/<img\b[^>]*\bsrc="([^"]+)"/i)?.[1] || chunk.match(/data-image="([^"]+)"/i)?.[1] || '';
    const alt = decodeEntities(chunk.match(/<img\b[^>]*\balt="([^"]*)"/i)?.[1] || '');
    const animeSlug = chunk.match(/\/anime\/([a-z0-9][a-z0-9-]{1,199})\//)?.[1] || '';

    let episodeSlug = '';
    const rawEpisode = chunk.match(/\/episode\/([^"/]+)\//)?.[1] || '';
    try {
      episodeSlug = decodeURIComponent(rawEpisode);
    } catch {
      episodeSlug = '';
    }

    const titled = decodeEntities(chunk.match(/anime-card-title[^>]*\btitle="([^"]*)"/)?.[1] || '');
    const epLabel = stripTags(chunk.match(/class="ep_num"[\s\S]{0,400}?<\/a>/)?.[0] || '');
    const title = titled || alt || '';

    if (!title && !episodeSlug && !animeSlug) continue;
    cards.push({ poster: decodeEntities(img), title, epLabel, episodeSlug, animeSlug });
  }

  return cards;
}

export async function latest() {
  const html = await fetchText(`${BASE}/home8/`);

  const items = [];
  const seen = new Set();
  for (const card of parseCards(html)) {
    if (items.length >= 36) break;
    const slug = card.episodeSlug;
    if (!slug || !validEpisodeId(slug) || seen.has(slug)) continue;
    seen.add(slug);

    const number = episodeNumber(slug, card.epLabel);
    items.push({
      id: EPISODE_ID(slug),
      slug,
      title: card.title || displayTitle(slug.replace(/-/g, ' ')),
      number,
      poster: card.poster,
      seriesSlug: '',
    });
  }

  return items;
}

// site search: series cards (poster + arabic/romaji title)
export async function search(term) {
  const html = await fetchText(`${BASE}/?s=${encodeURIComponent(term)}`);

  const items = [];
  const seen = new Set();
  for (const card of parseCards(html)) {
    if (items.length >= 30) break;
    const slug = card.animeSlug;
    if (!isSeriesSlug(slug) || seen.has(slug)) continue;
    if (!card.poster && !card.title) continue;
    seen.add(slug);

    items.push({
      slug,
      title: card.title || slug.replace(/-/g, ' '),
      poster: card.poster,
      link: `${BASE}/anime/${slug}/`,
    });
  }

  return items;
}

// the site's full catalog: /قائمة-الانمي/ pages 1..118, 20 series each
const LIST_PATH = encodeURIComponent('قائمة-الانمي');
const MAX_LIST_PAGES = 118;

export async function browse(page = 1) {
  const requested = Math.max(1, Math.min(MAX_LIST_PAGES, Number(page) || 1));
  const html = await fetchText(`${BASE}/${LIST_PATH}/${requested > 1 ? `page/${requested}/` : ''}`);

  const results = [];
  const seen = new Set();
  for (const card of parseCards(html)) {
    const slug = card.animeSlug;
    if (!isSeriesSlug(slug) || seen.has(slug)) continue;
    if (!card.poster && !card.title) continue;
    seen.add(slug);
    results.push({
      slug,
      title: card.title || slug.replace(/-/g, ' '),
      poster: card.poster,
      link: `${BASE}/anime/${slug}/`,
    });
  }

  const declared = [...html.matchAll(/page\/(\d+)\//g)].map((m) => Number(m[1])).filter(Number.isFinite);
  const pages = Math.min(MAX_LIST_PAGES, Math.max(1, requested, ...declared));

  return { page: requested, pages, results };
}

// one series page: title, art, synopsis, every episode
export async function series(slug) {
  if (!isSeriesSlug(slug)) fail('bad series id', 400);

  const html = await fetchText(`${BASE}/anime/${slug}/`);
  const found = await seriesEpisodes(slug);

  const title =
    stripTags(html.match(/<h1[^>]*class="[^"]*anime-details-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/)?.[1] || '') ||
    displayTitle(ogTitle(html)) ||
    slug.replace(/-/g, ' ');

  const synopsis =
    stripTags(html.match(/class="anime-story"[^>]*>([\s\S]*?)<\/p>/)?.[1] || '') ||
    ogDescription(html);

  const poster =
    decodeEntities(
      html.match(/class="anime-thumbnail"[\s\S]{0,400}?<img[^>]+src="([^"]+)"/)?.[1] || '',
    ) || ogImage(html);

  const genres = [...html.matchAll(/\/anime-genre\/[^"]*"[^>]*>([^<]+)</g)]
    .map((m) => stripTags(m[1]))
    .filter(Boolean)
    .slice(0, 6);

  const episodes = [...found.entries()]
    .map(([number, episodeSlug]) => ({ id: EPISODE_ID(episodeSlug), number, title: '', audio: 'ja', subs: 'ar' }))
    .sort((a, b) => a.number - b.number);

  if (!episodes.length) fail('source has no episodes for this title', 404);

  return {
    provider: 'anime4up',
    slug,
    title,
    poster,
    banner: poster,
    synopsis,
    genres,
    audio: 'ja',
    subtitles: 'ar',
    episodes,
  };
}

