// AniList GraphQL client. Metadata only — no content is hosted here.
const ENDPOINT = process.env.ANILIST_ENDPOINT || 'https://graphql.anilist.co';
const TIMEOUT_MS = 9000;
const RETRIES = 2;

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  description(asHtml: false)
  coverImage { extraLarge large color }
  bannerImage
  episodes
  duration
  status
  season
  seasonYear
  format
  averageScore
  popularity
  genres
  isAdult
  studios(isMain: true) { nodes { name } }
  trailer { id site }
  nextAiringEpisode { episode airingAt }
`;

const TRENDING_QUERY = `
  query Trending($page: Int) {
    Page(page: $page, perPage: 24) {
      media(sort: TRENDING_DESC, type: ANIME, isAdult: false) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

const SEASON_QUERY = `
  query Season($page: Int, $season: MediaSeason, $seasonYear: Int) {
    Page(page: $page, perPage: 24) {
      media(sort: POPULARITY_DESC, type: ANIME, isAdult: false, season: $season, seasonYear: $seasonYear) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

const SEARCH_QUERY = `
  query Search($search: String, $page: Int) {
    Page(page: $page, perPage: 30) {
      media(search: $search, type: ANIME, isAdult: false, sort: SEARCH_MATCH) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

const DETAIL_QUERY = `
  query Detail($id: Int) {
    Media(id: $id, type: ANIME) {
      ${MEDIA_FIELDS}
      recommendations(perPage: 12, sort: RATING_DESC) {
        nodes { mediaRecommendation { id title { romaji english } coverImage { large } averageScore format } }
      }
    }
  }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(query, variables) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.status === 429 || res.status >= 500) {
        lastError = tagged(`anilist ${res.status}`, res.status === 429 ? 429 : 504);
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (res.status === 404) throw tagged('anime not found', 404);
      if (!res.ok) throw tagged(`anilist ${res.status}`, 502);

      const json = await res.json();
      if (Array.isArray(json.errors) && json.errors.length) {
        const text = json.errors[0]?.message || 'anilist query failed';
        throw tagged(text, /not found/i.test(text) ? 404 : 502);
      }
      return json.data;
    } catch (err) {
      lastError = err;
      if (attempt === RETRIES) break;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : tagged('anilist unreachable', 504);
}

function tagged(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertMedia(media) {
  if (!media || typeof media.id !== 'number') throw tagged('anime not found', 404);
  return media;
}

export async function trending(page = 1) {
  const data = await request(TRENDING_QUERY, { page });
  return (data?.Page?.media ?? []).filter(Boolean);
}

export async function season(page = 1) {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const seasonName =
    month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL';
  const data = await request(SEASON_QUERY, {
    page,
    season: seasonName,
    seasonYear: now.getUTCFullYear(),
  });
  return (data?.Page?.media ?? []).filter(Boolean);
}

export async function search(term, page = 1) {
  const clean = String(term ?? '').trim();
  if (!clean) return [];
  const data = await request(SEARCH_QUERY, { search: clean.slice(0, 120), page });
  return (data?.Page?.media ?? []).filter(Boolean);
}

export async function detail(id) {
  const data = await request(DETAIL_QUERY, { id: Number(id) });
  return assertMedia(data?.Media);
}
