// anime bench — client. hash router, no framework, one store.
const view = document.getElementById('view');
const searchForm = document.getElementById('search-form');
const qInput = document.getElementById('q');
const toastEl = document.getElementById('toast');

const LS_PROGRESS = 'ab.progress.v1';
const LS_LIST = 'ab.list.v1';

const state = {
  media: null,
  episodes: [],
  animeId: 0,
  ep: null,
  lang: 'ar',
  dub: false,
  track: '',
  subtitles: [],
  skip: null,
  skipped: new Set(),
  servers: [],
  serverIndex: 0,
  a4slug: '',
  restore: true,
  ccOn: true,
  hls: null,
  lastSave: 0,
  toastTimer: null,
  // bumped on every route change; async views carry it so a slow reply from
  // the page you just left can't paint over the page you asked for
  viewSeq: 0,
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const store = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota or private mode — progress is a nicety, not a requirement */
    }
  },
};

const readMap = (key) => {
  const value = store.read(key, {});
  return value && typeof value === 'object' ? value : {};
};

const fmtTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
};

const titleOf = (media) => media?.title?.english || media?.title?.romaji || media?.title?.native || 'untitled';

const DEFAULT_LANG = 'ar';

// lang: 'ar' = japanese audio + arabic softsubs (anime4up), 'sub' = japanese
// audio + english subs, 'dub' = english audio.
// arabic is the site default, so every non-ar track must say so in the url —
// a bare `#/watch/1/1` would silently fall back to the anime4up arabic run.
const episodeQuery = (lang) => (lang === 'dub' ? '?dub=1' : lang === 'ar' ? '?lang=ar' : '?lang=sub');
const watchHref = (id, number, lang = DEFAULT_LANG) => `#/watch/${id}/${number}${episodeQuery(lang)}`;

// arabic (anime4up) media carries a string id `a4:<series slug>` and owns its
// own series route, so resume cards point there instead of the anilist detail.
const mediaWatchHref = (media, number, lang = DEFAULT_LANG) =>
  media && typeof media.id === 'string' && media.id.startsWith('a4:')
    ? `#/a4/${media.id.slice(3)}/${number}`
    : watchHref(media?.id, number, lang);

const trackLabel = (lang) =>
  lang === 'dub' ? 'english dub' : lang === 'sub' ? 'japanese audio · english subs' : 'japanese audio · arabic subs';

// anime4up blocks hotlinked posters (403 on our localhost referer), so their
// images ride the same proxy as the streams with the site's own referer.
const A4_ORIGIN = 'https://w1.anime4up.rest/';
const imageSrc = (url) => {
  const value = String(url || '');
  if (!value) return '';
  // already routed through our proxy (e.g. stored in saved progress)
  if (value.startsWith('/api/stream?') || value.includes('/api/stream?url=')) return value;
  return /anime4up\./i.test(value)
    ? `/api/stream?url=${encodeURIComponent(value)}&ref=${encodeURIComponent(A4_ORIGIN)}`
    : value;
};

const prettySeason = (season, year) => {
  if (!season) return year ? String(year) : '';
  return `${season[0]}${season.slice(1).toLowerCase()}${year ? ` ${year}` : ''}`;
};

const stripHtml = (text) =>
  String(text ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&mdash;/g, '—')
    .trim();

// tiny GET memo: navigating back and forth (home ⇄ series ⇄ watch) used to
// re-request the same json every time, which is what flooded the rate limiter.
const memo = new Map();
const MEMO_TTL = 20_000;
const MEMO_MAX = 80;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path) {
  const now = Date.now();
  const cached = memo.get(path);
  if (cached && cached.until > now) return cached.value;

  const request = async () => {
    const res = await fetch(path, { signal: AbortSignal.timeout(25_000) });
    const body = await res.json().catch(() => null);
    return { res, body };
  };

  let { res, body } = await request();

  // the server refunds cache hits, so a 429 here means real pressure: wait the
  // advertised second and try once more instead of showing a dead-end error.
  const retryAfter = Number(res.headers.get('retry-after')) || 0;
  if (res.status === 429 && retryAfter > 0 && retryAfter <= 4) {
    await sleep(retryAfter * 1000 + 150);
    ({ res, body } = await request());
  }

  if (!res.ok) {
    const detail = body?.error || `request failed (${res.status})`;
    throw new Error(res.status === 429 ? `${detail} — give it a second, then retry` : detail);
  }

  if (!path.includes('/api/stream')) {
    memo.set(path, { value: body, until: Date.now() + MEMO_TTL });
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  }
  return body;
}

// clipboard api is https-only, and we're usually on plain http over the lan
async function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand('copy');
    field.remove();
    return ok;
  } catch {
    return false;
  }
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function render(html, seq) {
  if (seq !== undefined && seq !== state.viewSeq) return false;
  view.innerHTML = html;
  document.title = 'anime bench — watch free';
  return true;
}

function skeletonGrid(count = 12) {
  return `<div class="grid">${Array.from({ length: count }, () => '<div class="skeleton card"></div>').join('')}</div>`;
}

// ---------------- cards ----------------
function card(media, progress) {
  const score = Number.isFinite(media.averageScore) ? (media.averageScore / 10).toFixed(1) : null;
  const sub = [media.format, prettySeason(media.season, media.seasonYear)].filter(Boolean).join(' · ');
  const pct = progress && progress.duration > 0 ? Math.min(100, Math.round((progress.time / progress.duration) * 100)) : 0;

  return `<a class="card" href="#/anime/${media.id}">
    <div class="card-art">
      <img loading="lazy" decoding="async" src="${esc(media.coverImage?.large || '')}" alt="" />
      ${media.format ? `<span class="chip">${esc(media.format)}</span>` : ''}
      ${score ? `<span class="score">★ ${score}</span>` : ''}
      ${pct ? `<span class="progress-bar"><i style="width:${pct}%"></i></span>` : ''}
    </div>
    <div class="card-title">${esc(titleOf(media))}</div>
    <div class="card-sub">${esc(sub || '—')}</div>
  </a>`;
}

function rail(title, items, sub = '') {
  if (!items.length) return '';
  return `<section class="band">
    <div class="band-head"><h2>${esc(title)}</h2>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>
    <div class="rail">${items.join('')}</div>
  </section>`;
}

// anime4up cards carry a flat { title, poster, number } instead of anilist media
function arabicCard(item, href) {
  return `<a class="card" href="${href}">
    <div class="card-art">
      <img decoding="async" src="${esc(imageSrc(item.poster))}" alt="" />
      <span class="chip accent">عربي</span>
      ${item.number ? `<span class="score">ep ${esc(item.number)}</span>` : ''}
    </div>
    <div class="card-title">${esc(item.title || 'untitled')}</div>
    <div class="card-sub">${esc(item.number ? `episode ${item.number}` : 'anime4up')}</div>
  </a>`;
}

// ---------------- home ----------------
async function viewHome() {
  const seq = state.viewSeq;
  render(`<div class="skeleton hero"></div>${skeletonGrid(12)}`);

  const [main, arabic] = await Promise.allSettled([api('/api/home'), api('/api/a4/home')]);
  if (seq !== state.viewSeq) return;

  if (main.status !== 'fulfilled') {
    const a4 = arabic.status === 'fulfilled' ? arabic.value : null;
    const reason = main.reason?.message || 'request failed';

    // one blocked source shouldn't blank the whole page: fall back to the
    // anime4up shelf we already have and keep the failed one as a notice.
    if (a4?.latest?.length) {
      document.title = 'anime bench — watch free';
      render(
        `
        <div class="notice">the anilist shelves are busy (${esc(reason)}) — showing anime4up instead.
          <button class="btn ghost" data-retry="home" type="button">retry</button></div>
        ${rail(
          'أحدث الحلقات · anime4up',
          a4.latest.slice(0, 18).map((item) => arabicCard(item, `#/a4e/${item.id.slice(3)}`)),
          'japanese audio · arabic subs',
        )}`,
        seq,
      );
      return;
    }

    render(
      `<div class="empty"><h2>the shelf is empty</h2><p>${esc(reason)}</p>
      <button class="btn primary" data-retry="home">try again</button></div>`,
      seq,
    );
    return;
  }

  const data = main.value;
  const a4 = arabic.status === 'fulfilled' ? arabic.value : null;

  const hero = data.hero;
  const progress = readMap(LS_PROGRESS);

  const heroHtml = hero
    ? `<section class="hero" style="--art:url('${esc(hero.bannerImage || hero.coverImage?.extraLarge || '')}')">
        <div class="hero-copy">
          <span class="hero-kicker">trending #1 right now</span>
          <h1>${esc(titleOf(hero))}</h1>
          <p>${esc(stripHtml(hero.description) || 'No synopsis on file.')}</p>
          <div class="hero-meta">
            ${hero.averageScore ? `<span class="chip accent">★ ${(hero.averageScore / 10).toFixed(1)}</span>` : ''}
            ${hero.format ? `<span class="chip">${esc(hero.format)}</span>` : ''}
            ${hero.episodes ? `<span class="chip">${hero.episodes} eps</span>` : ''}
            <span class="chip">${esc(prettySeason(hero.season, hero.seasonYear) || hero.status || '')}</span>
          </div>
          <div class="hero-actions">
            <a class="btn primary" href="${watchHref(hero.id, 1)}">
              <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> watch ep 1
            </a>
            <a class="btn ghost" href="#/anime/${hero.id}">details</a>
          </div>
        </div>
        <div class="hero-art"><img src="${esc(hero.coverImage?.extraLarge || '')}" alt="${esc(titleOf(hero))}" /></div>
      </section>`
    : '';

  const resume = Object.values(progress)
    .filter((entry) => entry && entry.media && entry.time > 20)
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, 14)
    .map((entry) =>
      card(
        { ...entry.media, coverImage: { large: imageSrc(entry.media.coverImage?.large) } },
        { time: entry.time, duration: entry.duration },
      ).replace(
        `href="#/anime/${entry.media.id}"`,
        `href="${mediaWatchHref(entry.media, entry.episode, entry.lang || (entry.dub ? 'dub' : DEFAULT_LANG))}"`,
      ),
    );

  render(
    `
    ${heroHtml}
    ${
      a4?.latest?.length
        ? rail(
            'أحدث الحلقات · anime4up',
            a4.latest.slice(0, 18).map((item) => arabicCard(item, `#/a4e/${item.id.slice(3)}`)),
            'japanese audio · arabic subs',
          )
        : ''
    }
    ${resume.length ? rail('continue watching', resume, 'picked up where you left off') : ''}
    ${rail('trending now', data.trending.map((m) => card(m)), 'this week')}
    ${rail('popular this season', data.season.map((m) => card(m)), prettySeason(data.season[0]?.season, data.season[0]?.seasonYear))}
  `,
    seq,
  );
}

// ---------------- search ----------------
async function viewSearch(term) {
  const seq = state.viewSeq;
  qInput.value = term;
  render(`<div class="band-head"><h2>search: ${esc(term)}</h2></div>${skeletonGrid(12)}`);

  const [main, arabic] = await Promise.allSettled([
    api(`/api/search?q=${encodeURIComponent(term)}`),
    api(`/api/a4/search?q=${encodeURIComponent(term)}`),
  ]);
  if (seq !== state.viewSeq) return;

  if (main.status !== 'fulfilled' && arabic.status !== 'fulfilled') {
    render(
      `<div class="empty"><h2>search failed</h2><p>${esc(main.reason?.message || 'request failed')}</p>
      <button class="btn primary" data-retry="search">try again</button></div>`,
      seq,
    );
    return;
  }

  const results = main.status === 'fulfilled' ? main.value.results || [] : [];
  const a4 = arabic.status === 'fulfilled' ? arabic.value.results || [] : [];

  if (!results.length && !a4.length) {
    render(
      `<div class="empty"><h2>nothing on the shelf</h2><p>no match for "${esc(term)}".</p>
      <a class="btn ghost" href="#/">back to trending</a></div>`,
      seq,
    );
    return;
  }

  document.title = `${term} — anime bench`;
  render(
    `<div class="band-head"><h2>${results.length + a4.length} results</h2><span class="sub">"${esc(term)}"</span></div>
    ${
      a4.length
        ? `<div class="band-head"><h2>عربي · anime4up</h2><span class="sub">japanese audio · arabic subs</span></div>
          <div class="grid">${a4.map((item) => arabicCard(item, `#/a4/${item.slug}`)).join('')}</div>`
        : ''
    }
    ${results.length ? `<div class="grid">${results.map((m) => card(m)).join('')}</div>` : ''}`,
    seq,
  );
}

// ---------------- detail ----------------
async function viewAnime(id) {
  const seq = state.viewSeq;
  render(`<div class="skeleton hero"></div><div class="skeleton" style="height:320px"></div>`);

  let media;
  try {
    media = await api(`/api/anime/${id}`);
  } catch (err) {
    if (seq !== state.viewSeq) return;
    render(
      `<div class="empty"><h2>can't open this one</h2><p>${esc(err.message)}</p>
      <a class="btn ghost" href="#/">back</a></div>`,
      seq,
    );
    return;
  }
  if (seq !== state.viewSeq) return;

  document.title = `${titleOf(media)} — anime bench`;
  state.media = media;
  state.animeId = Number(id);
  state.a4slug = '';
  const listed = Boolean(readMap(LS_LIST)[media.id]);
  const studio = media.studios?.nodes?.[0]?.name;
  const synopsis = stripHtml(media.description);

  render(`
    <article class="detail">
      <div class="detail-banner" style="--art:url('${esc(media.bannerImage || media.coverImage?.extraLarge || '')}')"></div>
      <div class="detail-poster"><img src="${esc(media.coverImage?.extraLarge || '')}" alt="${esc(titleOf(media))}" /></div>
      <div>
        <h1 class="detail-title">${esc(titleOf(media))}</h1>
        <p class="detail-alt">${esc([media.title?.romaji, media.title?.native].filter(Boolean).join(' · '))}</p>
        <div class="hero-meta">
          ${media.averageScore ? `<span class="chip accent">★ ${(media.averageScore / 10).toFixed(1)}</span>` : ''}
          ${(media.genres || []).map((g) => `<span class="chip">${esc(g)}</span>`).join('')}
        </div>
        <div class="stats">
          <div class="stat"><b>${esc(media.format || '—')}</b><span>format</span></div>
          <div class="stat"><b>${media.episodes || '?'}</b><span>episodes</span></div>
          <div class="stat"><b>${media.duration ? `${media.duration}m` : '—'}</b><span>runtime</span></div>
          <div class="stat"><b>${esc(media.status ? media.status.replace(/_/g, ' ').toLowerCase() : '—')}</b><span>status</span></div>
          <div class="stat"><b>${esc(prettySeason(media.season, media.seasonYear) || '—')}</b><span>season</span></div>
          <div class="stat"><b>${esc(studio || '—')}</b><span>studio</span></div>
        </div>
        <p class="detail-syn">${esc(synopsis || 'No synopsis on file.')}</p>
        <div class="detail-actions">
          <a class="btn primary" href="${watchHref(media.id, 1)}"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> play ep 1</a>
          <button class="btn ghost" data-list="${media.id}">${listed ? 'remove from list' : 'add to list'}</button>
          <div class="seg" role="group" aria-label="audio">
            <button type="button" data-lang="ar" aria-pressed="true">عربي</button>
            <button type="button" data-lang="sub" aria-pressed="false">sub</button>
            <button type="button" data-lang="dub" aria-pressed="false">dub</button>
          </div>
        </div>
        <section class="episode-panel" id="episode-panel">
          <div class="episode-toolbar"><h3>episodes</h3></div>
          ${skeletonGrid(10)}
        </section>
      </div>
    </article>
  `,
    seq,
  );

  loadEpisodeGrid(media, DEFAULT_LANG);
}

async function loadEpisodeGrid(media, lang) {
  const panel = document.getElementById('episode-panel');
  if (!panel || !media?.id) return;

  try {
    const data = await api(`/api/episodes/${media.id}${episodeQuery(lang)}`);
    state.episodes = data.episodes;
    state.lang = lang;
    state.dub = lang === 'dub';

    const episodes = data.episodes;
    const ranges = [];
    for (let start = 0; start < episodes.length; start += 100) {
      ranges.push({ start, end: Math.min(episodes.length, start + 100) });
    }

    const picker =
      ranges.length > 1
        ? `<select class="range-select" data-range>
            ${ranges
              .map(
                (r, i) =>
                  `<option value="${i}">ep ${episodes[r.start].number}–${episodes[r.end - 1].number}</option>`,
              )
              .join('')}
          </select>`
        : '';

    panel.innerHTML = `
      <div class="episode-toolbar"><h3>${trackLabel(lang)} · ${episodes.length} episodes</h3>${picker}</div>
      <div class="episodes">${episodes
        .map(
          (ep) =>
            `<a class="ep${ep.isFiller ? ' filler' : ''}" href="${watchHref(media.id, ep.number, lang)}" title="episode ${ep.number}${ep.title ? ` — ${esc(ep.title)}` : ''}">${ep.number}</a>`,
        )
        .join('')}</div>`;

    const select = panel.querySelector('[data-range]');
    if (select) {
      const limit = (index) => {
        const grid = panel.querySelector('.episodes');
        if (!grid) return;
        const { start, end } = ranges[index];
        grid.innerHTML = episodes
          .slice(start, end)
          .map(
            (ep) =>
              `<a class="ep${ep.isFiller ? ' filler' : ''}" href="${watchHref(media.id, ep.number, lang)}">${ep.number}</a>`,
          )
          .join('');
        grid.scrollTop = 0;
      };
      select.addEventListener('change', () => limit(Number(select.value)));
    }

    // keep the primary play button on the track that just loaded
    const play = document.querySelector('.detail-actions a.btn.primary');
    if (play && episodes[0]) play.setAttribute('href', watchHref(media.id, episodes[0].number, lang));
  } catch (err) {
    panel.innerHTML = `
      <div class="episode-toolbar"><h3>episodes</h3></div>
      <div class="notice">${esc(err.message)} — switch the audio track above; عربي plays the anime4up run.</div>`;
  }
}

// ---------------- watch ----------------
async function viewWatch(animeId, epNumber, lang, options = {}) {
  const seq = state.viewSeq;
  const a4slug = options.a4slug || '';
  render(`<div class="skeleton hero"></div>`);

  let media;
  let data;
  try {
    if (a4slug) {
      const s = await api(`/api/a4/series/${encodeURIComponent(a4slug)}`);
      media = {
        id: `a4:${a4slug}`,
        title: { romaji: s.title, english: s.title },
        coverImage: { large: imageSrc(s.poster), extraLarge: imageSrc(s.poster) },
        bannerImage: imageSrc(s.banner || s.poster),
        description: s.synopsis || '',
        format: 'TV',
        episodes: s.episodes.length,
        genres: s.genres || [],
      };
      data = { provider: 'anime4up', audio: 'ja', subtitles: 'ar', episodes: s.episodes };
    } else {
      [media, data] = await Promise.all([
        api(`/api/anime/${animeId}`),
        api(`/api/episodes/${animeId}${episodeQuery(lang)}`),
      ]);
    }
  } catch (err) {
    if (seq !== state.viewSeq) return;
    render(
      `<div class="empty"><h2>player can't open</h2><p>${esc(err.message)}</p>
      <a class="btn ghost" href="${a4slug ? `#/a4/${encodeURIComponent(a4slug)}` : `#/anime/${animeId}`}">back to details</a></div>`,
      seq,
    );
    return;
  }

  if (seq !== state.viewSeq) return;

  state.media = media;
  state.a4slug = a4slug;
  state.animeId = a4slug ? media.id : Number(animeId);
  state.episodes = data.episodes;
  state.lang = lang;
  state.dub = lang === 'dub';
  document.title = `${titleOf(media)} ep ${epNumber} — anime bench`;

  const effLang = data.subtitles === 'ar' ? 'ar' : lang === 'dub' ? 'dub' : 'sub';
  state.track = trackLabel(effLang);

  const ep = data.episodes.find((entry) => entry.number === Number(epNumber)) || data.episodes[0];
  if (!ep) {
    render(
      `<div class="empty"><h2>no episodes</h2><p>this source returned an empty run.</p></div>`,
      seq,
    );
    return;
  }

  render(`
    <div class="watch-wrap">
      <div class="player-col">
        <div class="player" id="player" tabindex="0">
          <video id="video" playsinline controls preload="metadata"></video>
          <div class="player-state" id="player-state">
            <div class="spinner"></div><span>loading source…</span>
          </div>
        </div>
        <div class="watch-head">
          <div>
            <h1>${esc(titleOf(media))}</h1>
            <div class="sub">episode ${ep.number}${ep.title ? ` · ${esc(ep.title)}` : ''} · ${trackLabel(effLang)}</div>
          </div>
          <div class="watch-controls">
            <button class="btn ghost icon" data-step="-1" title="previous episode (p)" aria-label="previous episode">‹</button>
            <button class="btn ghost icon" data-step="1" title="next episode (n)" aria-label="next episode">›</button>
            <select id="server" aria-label="server" autocomplete="off" hidden></select>
            <select id="quality" aria-label="quality" hidden></select>
            <button class="btn ghost" data-cc aria-pressed="true" title="subtitles (c)" hidden>cc</button>
            <a class="btn ghost" href="${a4slug ? `#/a4/${encodeURIComponent(a4slug)}` : `#/anime/${media.id}`}">details</a>
            <button class="btn ghost" data-theater title="fullscreen (f)">full screen</button>
          </div>
        </div>
      </div>
      <aside class="side">
        <div class="side-head"><span>episodes</span><span>${data.episodes.length}</span></div>
        <div class="side-list" id="side-list">
          ${data.episodes
            .map(
              (entry) => `<button class="side-item" data-ep="${entry.number}" type="button">
                <b>${entry.number}</b><span>${esc(entry.title || `episode ${entry.number}`)}</span>
              </button>`,
            )
            .join('')}
        </div>
      </aside>
    </div>
  `,
    seq,
  );

  // a newer route already painted; don't attach a player to someone else's page
  if (seq !== state.viewSeq) return;

  await loadEpisode(ep, { restore: true });
}

async function loadEpisode(ep, { restore = true, autoplay = true } = {}) {
  const video = document.getElementById('video');
  const shell = document.getElementById('player-state');
  const side = document.getElementById('side-list');
  if (!video || !shell) return;

  state.ep = ep;

  const headSub = document.querySelector('.watch-head .sub');
  if (headSub) {
    headSub.textContent = `episode ${ep.number}${ep.title ? ` · ${ep.title}` : ''} · ${state.track || trackLabel(state.lang)}`;
  }
  if (state.media) document.title = `${titleOf(state.media)} ep ${ep.number} — anime bench`;
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  video.pause();
  video.removeAttribute('src');
  video.load();

  shell.hidden = false;
  shell.innerHTML = `<div class="spinner"></div><span>loading source…</span>`;

  const qualitySelect = document.getElementById('quality');
  if (qualitySelect) {
    qualitySelect.hidden = true;
    qualitySelect.innerHTML = '';
  }
  const serverSelect = document.getElementById('server');
  if (serverSelect) {
    serverSelect.hidden = true;
    serverSelect.innerHTML = '';
  }

  if (side) {
    side.querySelectorAll('.side-item').forEach((button) => {
      button.classList.toggle('now', Number(button.dataset.ep) === ep.number);
    });
    side.querySelector('.now')?.scrollIntoView({ block: 'nearest' });
  }

  const url = state.a4slug || state.animeId;
  history.replaceState(
    null,
    '',
    state.a4slug
      ? `#/a4/${state.a4slug}/${ep.number}`
      : `#/watch/${url}/${ep.number}${episodeQuery(state.lang)}`,
  );

  state.subtitles = [];
  state.skip = null;
  state.skipped = new Set();

  let payload;
  try {
    payload = await api(`/api/watch/${encodeURIComponent(ep.id)}`);
  } catch (err) {
    const offline = /offline|no player|no such episode|no playable/i.test(err.message);
    shell.innerHTML = `<strong>${offline ? 'mirror offline' : 'source unavailable'}</strong>
      <span>${offline ? 'this episode has no working player right now — pick another episode.' : esc(err.message)}</span>
      <div class="player-actions">
        <button class="btn ghost" id="retry-source" type="button">retry</button>
        <button class="btn ghost" id="prev-source" type="button">← previous</button>
        <button class="btn ghost" id="next-source" type="button">next episode →</button>
      </div>`;
    document.getElementById('retry-source')?.addEventListener('click', () => loadEpisode(ep, { restore }));
    document.getElementById('prev-source')?.addEventListener('click', () => stepEpisode(-1));
    document.getElementById('next-source')?.addEventListener('click', () => stepEpisode(1));
    return;
  }

  const servers =
    Array.isArray(payload.servers) && payload.servers.length
      ? payload.servers
      : [
          {
            name: payload.server || 'source',
            label: '',
            sources: payload.sources || [],
            subtitles: payload.subtitles || [],
            skip: payload.skip || null,
          },
        ];

  const usable = servers.filter((server) => server.sources && server.sources.length);
  if (!usable.length) {
    shell.innerHTML = `<strong>no playable stream</strong><span>this episode has no direct source.</span>`;
    return;
  }

  state.servers = servers;
  state.restore = restore;
  const preferred = servers.findIndex((server) => server.softsub && server.sources?.length);
  state.serverIndex = preferred >= 0 ? preferred : servers.findIndex((server) => server.sources?.length);

  if (serverSelect && servers.length > 1) {
    serverSelect.hidden = false;
    serverSelect.innerHTML = servers
      .map((server, index) => {
        // softsub = anime4up's own vnx player: japanese audio + arabic <track>
        const bits = [server.name, server.label].filter(Boolean);
        if (server.softsub) bits.push('عربي softsub');
        return `<option value="${index}"${index === state.serverIndex ? ' selected' : ''}>${esc(bits.join(' · '))}</option>`;
      })
      .join('');
    serverSelect.value = String(state.serverIndex);
    serverSelect.onchange = () => {
      state.serverIndex = Number(serverSelect.value) || 0;
      selectServer(autoplay);
    };
    // chromium changes a focused <select> on wheel — that silently desynced the
    // picker from the server actually playing, so drop focus before it can.
    serverSelect.onwheel = () => serverSelect.blur();
  }

  selectServer(autoplay);
}

function selectServer(autoplay = true) {
  const video = document.getElementById('video');
  const shell = document.getElementById('player-state');
  const qualitySelect = document.getElementById('quality');
  const server = state.servers?.[state.serverIndex];
  if (!video || !shell || !server) return;

  // the picker is the source of truth for the user; keep it pinned to whatever
  // we are attaching so browser form-state quirks can never leave it lying.
  const serverSelect = document.getElementById('server');
  if (serverSelect && !serverSelect.hidden) serverSelect.value = String(state.serverIndex);

  state.subtitles = Array.isArray(server.subtitles) ? server.subtitles : [];
  state.skip = server.skip && typeof server.skip === 'object' ? server.skip : null;
  state.skipped = new Set();
  syncSubtitleButton();

  const sources = (server.sources || []).filter((source) => source && source.url);
  if (!sources.length) {
    shell.hidden = false;
    shell.innerHTML = `<strong>no stream on this server</strong><span>pick another one from the list.</span>`;
    return;
  }

  if (qualitySelect) {
    if (sources.length > 1) {
      qualitySelect.hidden = false;
      qualitySelect.innerHTML = sources
        .map((source, index) => `<option value="${index}">${esc(source.quality || 'auto')}</option>`)
        .join('');
      qualitySelect.value = '0';
      qualitySelect.onchange = () => {
        const picked = sources[Number(qualitySelect.value)] || sources[0];
        attach(video, shell, picked, state.restore, autoplay);
      };
      qualitySelect.onwheel = () => qualitySelect.blur();
    } else {
      qualitySelect.hidden = true;
      qualitySelect.innerHTML = '';
    }
  }

  attach(video, shell, sources[0], state.restore, autoplay);
}

function attach(video, shell, source, restore, autoplay) {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }

  const player = document.getElementById('player');

  // provider-embed source: their watch page owns playback, we frame it
  if (source.isEmbed) {
    player?.querySelector('iframe.embed')?.remove();
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.style.display = 'none';
    shell.hidden = true;

    const frame = document.createElement('iframe');
    frame.className = 'embed';
    frame.src = source.url;
    frame.title = 'player';
    frame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('scrolling', 'no');
    player?.appendChild(frame);

    const select = document.getElementById('quality');
    if (select) select.hidden = true;
    return;
  }

  player?.querySelector('iframe.embed')?.remove();
  video.style.display = '';
  installSubtitles(video);

  const url = source.proxy || source.url;
  const isHls = source.isM3U8;

  const reveal = () => {
    shell.hidden = true;
  };

  video.onerror = () => {
    shell.hidden = false;
    shell.innerHTML = `<strong>stream dropped</strong><span>the source refused or the segment failed.</span>
      <button class="btn ghost" id="retry-source" type="button">retry</button>`;
    document.getElementById('retry-source')?.addEventListener('click', () => attach(video, shell, source, restore, autoplay));
  };

  video.onloadedmetadata = () => {
    applySubtitleMode();
    reveal();
    if (!restore) return;
    const saved = readMap(LS_PROGRESS)[progressKey()];
    if (saved && Number.isFinite(saved.time) && saved.time > 10) {
      const target = Math.min(saved.time, (video.duration || saved.time) - 4);
      if (target > 0) video.currentTime = target;
      // a resume inside the intro/outro should still land past it
      state.skipped.clear();
      setTimeout(() => checkSkip(video), 300);
    }
  };

  if (isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({
      maxBufferLength: 40,
      maxMaxBufferLength: 90,
      enableWorker: true,
      lowLatencyMode: false,
    });
    state.hls = hls;
    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(window.Hls.Events.ERROR, (_event, details) => {
      if (!details.fatal) return;
      if (details.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
      } else if (details.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        hls.destroy();
        state.hls = null;
        shell.hidden = false;
        shell.innerHTML = `<strong>playback failed</strong><span>the manifest didn't survive parsing.</span>`;
      }
    });
  } else {
    video.src = url;
  }

  if (autoplay) {
    video.play().catch(() => {
      shell.hidden = false;
      shell.innerHTML = `<button class="btn primary" id="tap-play" type="button">tap to play</button>`;
      document.getElementById('tap-play')?.addEventListener('click', () => {
        shell.hidden = true;
        video.play().catch(() => toast('browser refused playback'));
      });
    });
  }

  video.ontimeupdate = () => {
    checkSkip(video);
    if (!video.duration || !Number.isFinite(video.duration)) return;
    const now = Date.now();
    if (now - state.lastSave < 5000) return;
    state.lastSave = now;
    saveProgress(video.currentTime, video.duration);
  };

  video.onended = () => stepEpisode(1);
}

// ---------------- subtitles + skips ----------------
function videoTracks() {
  const video = document.getElementById('video');
  if (!video || !video.textTracks) return [];
  return Array.from(video.textTracks).filter((track) => track.kind === 'subtitles');
}

function installSubtitles(video) {
  video.querySelectorAll('track').forEach((track) => track.remove());
  for (const sub of state.subtitles) {
    if (!sub || typeof sub.url !== 'string') continue;
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.src = sub.url;
    track.srclang = sub.lang || 'ar';
    track.label = sub.label || 'العربية';
    track.default = Boolean(sub.default);
    video.appendChild(track);
  }
  applySubtitleMode();
}

function applySubtitleMode() {
  for (const track of videoTracks()) {
    track.mode = state.ccOn ? 'showing' : 'hidden';
  }
}

function syncSubtitleButton() {
  const button = document.querySelector('[data-cc]');
  if (!button) return;
  button.hidden = state.subtitles.length === 0;
  button.setAttribute('aria-pressed', String(state.ccOn));
  button.textContent = state.ccOn ? 'cc on' : 'cc off';
}

function toggleSubtitles() {
  if (!state.subtitles.length) {
    toast('no subtitles on this source');
    return;
  }
  state.ccOn = !state.ccOn;
  applySubtitleMode();
  syncSubtitleButton();
}

function checkSkip(video) {
  const skip = state.skip;
  if (!skip || !Number.isFinite(video.currentTime)) return;
  for (const [key, range] of Object.entries(skip)) {
    const start = Number(range && range.start);
    const end = Number(range && range.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (state.skipped.has(key)) continue;
    if (video.currentTime >= start && video.currentTime < end - 1) {
      state.skipped.add(key);
      video.currentTime = end;
      // a pending hls seek can swallow the first jump — nudge it once more
      setTimeout(() => {
        if (Number.isFinite(video.currentTime) && video.currentTime < end - 1) video.currentTime = end + 0.1;
      }, 450);
      toast(key === 'outro' ? 'skipped outro' : 'skipped intro');
    }
  }
}

function progressKey() {
  return `${state.animeId}:${state.lang}:${state.ep?.number ?? 0}`;
}

function saveProgress(time, duration) {
  if (!state.media || !state.ep || !Number.isFinite(time) || time < 5) return;
  const map = readMap(LS_PROGRESS);
  const key = progressKey();

  const slim = {
    id: state.media.id,
    title: state.media.title,
    coverImage: { large: state.media.coverImage?.large || '' },
    format: state.media.format,
    season: state.media.season,
    seasonYear: state.media.seasonYear,
    averageScore: state.media.averageScore,
  };

  map[key] = {
    media: slim,
    episode: state.ep.number,
    lang: state.lang,
    dub: state.lang === 'dub',
    time: Math.floor(time),
    duration: Math.floor(duration || 0),
    savedAt: Date.now(),
  };

  const keys = Object.keys(map);
  if (keys.length > 60) {
    keys
      .sort((a, b) => (map[a].savedAt || 0) - (map[b].savedAt || 0))
      .slice(0, keys.length - 60)
      .forEach((old) => delete map[old]);
  }

  store.write(LS_PROGRESS, map);
}

function stepEpisode(delta) {
  if (!state.ep) return;
  const index = state.episodes.findIndex((entry) => entry.number === state.ep.number);
  const next = state.episodes[index + delta];
  if (!next) {
    toast(delta > 0 ? 'that was the last episode' : 'that was the first episode');
    return;
  }
  const video = document.getElementById('video');
  if (video) saveProgress(video.currentTime, video.duration || 0);
  loadEpisode(next).catch((err) => toast(err.message));
}

// ---------------- arabic (anime4up) ----------------
async function viewArabicList(page = 1) {
  const seq = state.viewSeq;
  render(`<div class="band-head"><h2>كل الأنمي · anime4up</h2></div>${skeletonGrid(12)}`);

  let data;
  try {
    data = await api(`/api/a4/browse?page=${page}`);
  } catch (err) {
    if (seq !== state.viewSeq) return;
    render(
      `<div class="empty"><h2>can't load the catalog</h2><p>${esc(err.message)}</p>
      <a class="btn ghost" href="#/">back home</a></div>`,
      seq,
    );
    return;
  }
  if (seq !== state.viewSeq) return;

  document.title = 'all anime — anime bench';

  const prev = data.page > 1 ? `<a class="btn ghost" href="#/a4list/${data.page - 1}">‹ prev</a>` : '';
  const next = data.page < data.pages ? `<a class="btn ghost" href="#/a4list/${data.page + 1}">next ›</a>` : '';

  render(`
    <div class="band-head"><h2>كل الأنمي</h2><span class="sub">page ${data.page} / ${data.pages} · japanese audio · arabic subs</span></div>
    <div class="grid">${data.results.map((item) => arabicCard(item, `#/a4/${item.slug}`)).join('')}</div>
    <div class="pager">${prev}<span class="sub">${data.page} / ${data.pages}</span>${next}</div>
  `,
    seq,
  );
}

async function viewArabicSeries(slug) {
  const seq = state.viewSeq;
  render(`<div class="skeleton hero"></div><div class="skeleton" style="height:320px"></div>`);

  let s;
  try {
    s = await api(`/api/a4/series/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (seq !== state.viewSeq) return;
    render(
      `<div class="empty"><h2>can't open this one</h2><p>${esc(err.message)}</p>
      <a class="btn ghost" href="#/">back</a></div>`,
      seq,
    );
    return;
  }
  if (seq !== state.viewSeq) return;

  const media = {
    id: `a4:${slug}`,
    title: { romaji: s.title, english: s.title },
    coverImage: { large: imageSrc(s.poster), extraLarge: imageSrc(s.poster) },
    bannerImage: imageSrc(s.banner || s.poster),
    description: s.synopsis || '',
    format: 'TV',
    episodes: s.episodes.length,
    genres: s.genres || [],
  };

  state.media = media;
  state.a4slug = slug;
  document.title = `${s.title} — anime bench`;

  const first = s.episodes[0]?.number || 1;
  const synopsis = stripHtml(s.synopsis || '');

  render(`
    <article class="detail">
      <div class="detail-banner" style="--art:url('${esc(imageSrc(s.banner || s.poster))}')"></div>
      <div class="detail-poster"><img src="${esc(imageSrc(s.poster))}" alt="${esc(s.title)}" /></div>
      <div>
        <h1 class="detail-title">${esc(s.title)}</h1>
        <p class="detail-alt">anime4up · japanese audio · arabic subtitles</p>
        <div class="hero-meta">
          <span class="chip accent">عربي</span>
          ${(s.genres || []).map((g) => `<span class="chip">${esc(g)}</span>`).join('')}
        </div>
        <div class="stats">
          <div class="stat"><b>${s.episodes.length}</b><span>episodes</span></div>
          <div class="stat"><b>ja</b><span>audio</span></div>
          <div class="stat"><b>ar</b><span>subtitles</span></div>
        </div>
        <p class="detail-syn">${esc(synopsis || 'No synopsis on file.')}</p>
        <div class="detail-actions">
          <a class="btn primary" href="#/a4/${encodeURIComponent(slug)}/${first}"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> play ep ${first}</a>
        </div>
        <section class="episode-panel">
          <div class="episode-toolbar"><h3>japanese audio · arabic subs · ${s.episodes.length} episodes</h3></div>
          <div class="episodes">${s.episodes
            .map(
              (ep) =>
                `<a class="ep" href="#/a4/${encodeURIComponent(slug)}/${ep.number}" title="episode ${ep.number}">${ep.number}</a>`,
            )
            .join('')}</div>
        </section>
      </div>
    </article>
  `,
    seq,
  );
}

// home/search cards only know the episode token; resolve it to a series page
async function viewArabicEpisode(token) {
  const seq = state.viewSeq;
  render(`<div class="skeleton hero"></div>`);

  let payload;
  try {
    payload = await api(`/api/watch/a4:${encodeURIComponent(token)}`);
  } catch (err) {
    if (seq !== state.viewSeq) return;
    render(
      `<div class="empty"><h2>can't open this episode</h2><p>${esc(err.message)}</p>
      <a class="btn ghost" href="#/">back home</a></div>`,
      seq,
    );
    return;
  }
  if (seq !== state.viewSeq) return;

  const slug = payload.meta?.seriesSlug || '';
  const number = Number(payload.meta?.number) || 1;

  if (slug) {
    location.replace(`#/a4/${slug}/${number}`);
    return;
  }

  render(
    `<div class="empty"><h2>${esc(payload.meta?.title || 'episode')}</h2>
    <p>this episode has no series page on the source.</p>
    <a class="btn ghost" href="#/">back home</a></div>`,
    seq,
  );
}

// ---------------- share (phone / other pc) ----------------
async function viewShare() {
  const seq = state.viewSeq;
  document.title = 'watch on your phone — anime bench';

  let net = null;
  try {
    net = await api('/api/net');
  } catch {
    net = null;
  }
  if (seq !== state.viewSeq) return;

  const hosted = Boolean(net?.hosted);
  const urls = net?.urls?.length ? net.urls : net?.origin ? [net.origin] : [];
  const suffix = net?.needsCode ? '?k=YOUR-CODE' : '';
  const qr = net?.qr || '';
  const port = esc(String(net?.port || 8787));

  const rows = urls.length
    ? urls
        .map(
          (url) => `<div class="share-row">
            <code>${esc(url)}${esc(suffix)}</code>
            <button class="btn ghost" type="button" data-copy="${esc(url + suffix)}">copy</button>
            <a class="btn ghost" href="${esc(url + suffix)}">open</a>
          </div>`,
        )
        .join('')
    : `<div class="notice">no address found — open this page over the network, not from a saved file.</div>`;

  const steps = hosted
    ? `<li>this copy runs on the internet — <strong>your pc can stay off</strong></li>
       <li>open the address below on any phone or pc</li>
       <li>scan the code with the phone camera</li>`
    : `<li>keep this pc awake with <code>npm start</code> running</li>
       <li>on the phone, connect to the <strong>same wifi</strong> as this pc</li>
       <li>open one of these addresses in the phone browser</li>`;

  const firewallCard = hosted
    ? ''
    : `<section class="share-card">
        <h3>it doesn't load on the phone?</h3>
        <p class="share-hint">windows firewall is the usual culprit. allow node once, in an admin powershell:</p>
        <pre class="share-code">New-NetFirewallRule -DisplayName "anime bench" -Direction Inbound -LocalPort ${port} -Protocol TCP -Action Allow -Profile Private</pre>
        <p class="share-hint">also make sure the network is marked <strong>private</strong> in windows (settings → network → properties).</p>
      </section>`;

  const tailCard = hosted
    ? `<section class="share-card">
        <h3>keep it online for free</h3>
        <p class="share-hint">this build is stateless, so it drops onto a free host: render (sleeps when idle), hugging face spaces, or an oracle always-free vm. the repo already has a <code>Dockerfile</code> and <code>render.yaml</code> — see <code>DEPLOY.md</code>.</p>
        <p class="share-hint">bandwidth is the real limit: ~0.5–1 GB per 1080p episode, so a 100 GB/month tier is roughly 100–200 episodes.</p>
        <p class="share-hint">set <code>ACCESS_CODE</code> in the host's environment so strangers can't use your scrapers.</p>
      </section>`
    : `<section class="share-card">
        <h3>outside the house</h3>
        <p class="share-hint">a home ip isn't reachable from the internet by itself, so pick one:</p>
        <ul class="share-steps">
          <li><strong>tailscale</strong> (recommended) — free, private, no port forwarding. install it on this pc and the phone, then open <code>http://<em>this-pc-name</em>:${port}</code> from anywhere.</li>
          <li><strong>cloudflared tunnel</strong> — public link, no account: <code>cloudflared tunnel --url http://localhost:${port}</code></li>
          <li><strong>free host</strong> — put it on render/hugging face/oracle and your pc can be off entirely (see <code>DEPLOY.md</code>).</li>
        </ul>
        <p class="share-hint">before you expose it, restart with a code so strangers can't use your scrapers:</p>
        <pre class="share-code">$env:ACCESS_CODE="pick-something"; npm start</pre>
        <p class="share-hint">then share the link with <code>?k=pick-something</code> — every device only types it once.</p>
      </section>`;

  render(`
    <div class="band-head"><h2>watch on your phone or another pc</h2><span class="sub">${
      hosted ? 'runs without your pc' : 'same wifi, no app needed'
    }</span></div>

    <section class="share-card">
      <ol class="share-steps">${steps}</ol>

      ${rows}
      ${qr ? `<div class="share-qr">${qr}<span>scan with the phone camera</span></div>` : ''}

      <p class="share-hint">${
        hosted
          ? 'bookmark it — the address is permanent and needs nothing from this pc.'
          : "bookmark it on the phone — the address stays the same as long as your router doesn't hand this pc a new ip."
      }</p>
    </section>

    ${firewallCard}
    ${tailCard}
  `,
    seq,
  );
}
// ---------------- list ----------------
function viewList() {
  const map = readMap(LS_LIST);
  const items = Object.values(map).filter((media) => media && media.id);

  document.title = 'my list — anime bench';

  if (!items.length) {
    render(`<div class="empty"><h2>my list is empty</h2><p>open any title and hit "add to list".</p>
      <a class="btn primary" href="#/">browse trending</a></div>`);
    return;
  }

  render(`<div class="band-head"><h2>my list</h2><span class="sub">${items.length} saved</span></div>
    <div class="grid">${items
      .map((media) => card(media))
      .join('')}</div>`);
}

function toggleList(id) {
  const map = readMap(LS_LIST);
  if (map[id]) {
    delete map[id];
    store.write(LS_LIST, map);
    toast('removed from list');
  } else {
    const media = state.media && state.media.id === Number(id) ? state.media : null;
    if (!media) return;
    map[id] = {
      id: media.id,
      title: media.title,
      coverImage: { large: media.coverImage?.large || '' },
      format: media.format,
      season: media.season,
      seasonYear: media.seasonYear,
      averageScore: media.averageScore,
    };
    store.write(LS_LIST, map);
    toast('added to list');
  }
}

// ---------------- router ----------------
function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathname, query] = raw.split('?');
  return { parts: pathname.split('/').filter(Boolean), query: new URLSearchParams(query || '') };
}

async function route() {
  state.viewSeq += 1;

  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }

  const { parts, query } = parseRoute();
  const [head, a, b] = parts;

  if (!head) return viewHome();
  if (head === 'search') return viewSearch((query.get('q') || a || '').trim());
  if (head === 'anime' && a) return viewAnime(a);
  if (head === 'watch' && a) {
    const requested = query.get('lang');
    const lang = requested === 'sub' ? 'sub' : requested === 'ar' ? 'ar' : query.get('dub') === '1' ? 'dub' : DEFAULT_LANG;
    return viewWatch(a, Number(b || 1) || 1, lang);
  }
  if (head === 'a4' && a) {
    return b
      ? viewWatch(a, Number(b) || 1, 'ar', { a4slug: a })
      : viewArabicSeries(a);
  }
  if (head === 'share') return viewShare();
  if (head === 'a4e' && a) return viewArabicEpisode(a);
  if (head === 'a4list') return viewArabicList(Number(a) || 1);
  if (head === 'list') return viewList();
  if (head === 'random') {
    try {
      const data = await api('/api/home');
      const pool = [...data.trending, ...data.season];
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick) {
        location.replace(`#/anime/${pick.id}`);
        return;
      }
    } catch {
      /* fall through to home */
    }
    location.replace('#/');
    return;
  }

  render(`<div class="empty"><h2>nothing here</h2><p>that route doesn't exist.</p>
    <a class="btn ghost" href="#/">go home</a></div>`);
}

// ---------------- events ----------------
searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const term = qInput.value.trim();
  if (term.length < 2) {
    toast('two characters minimum');
    return;
  }
  location.hash = `#/search?q=${encodeURIComponent(term)}`;
});

document.addEventListener('click', (event) => {
  const target = event.target;

  const retry = target.closest('[data-retry]');
  if (retry) {
    const kind = retry.dataset.retry;
    if (kind === 'home') viewHome();
    else route();
    return;
  }

  const copyButton = target.closest('[data-copy]');
  if (copyButton) {
    copyText(copyButton.dataset.copy || '').then((ok) => {
      if (!ok) return toast('select the address and copy it by hand');
      copyButton.textContent = 'copied';
      setTimeout(() => (copyButton.textContent = 'copy'), 1500);
    });
    return;
  }

  const listButton = target.closest('[data-list]');
  if (listButton) {
    toggleList(listButton.dataset.list);
    const saved = Boolean(readMap(LS_LIST)[listButton.dataset.list]);
    listButton.textContent = saved ? 'remove from list' : 'add to list';
    return;
  }

  const audio = target.closest('[data-lang]');
  if (audio) {
    const lang = audio.dataset.lang;
    const group = audio.closest('.seg');
    group.querySelectorAll('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button === audio));
    });
    state.lang = lang;
    state.dub = lang === 'dub';
    loadEpisodeGrid(state.media, lang);
    return;
  }

  const cc = target.closest('[data-cc]');
  if (cc) {
    toggleSubtitles();
    return;
  }

  const step = target.closest('[data-step]');
  if (step) {
    stepEpisode(Number(step.dataset.step));
    return;
  }

  const theater = target.closest('[data-theater]');
  if (theater) {
    const player = document.getElementById('player');
    if (!document.fullscreenElement) player?.requestFullscreen?.().catch(() => toast('fullscreen refused'));
    else document.exitFullscreen?.();
    return;
  }

  const episodeButton = target.closest('[data-ep]');
  if (episodeButton) {
    const number = Number(episodeButton.dataset.ep);
    const ep = state.episodes.find((entry) => entry.number === number);
    if (ep) loadEpisode(ep).catch((err) => toast(err.message));
  }
});

window.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);

  if (event.key === '/' && !typing) {
    event.preventDefault();
    qInput.focus();
    qInput.select();
    return;
  }

  if (!location.hash.startsWith('#/watch') && !location.hash.startsWith('#/a4/')) return;
  if (typing) return;
  const video = document.getElementById('video');
  const embedded = Boolean(document.querySelector('#player iframe.embed'));

  if (event.key === 'n') stepEpisode(1);
  else if (event.key === 'p') stepEpisode(-1);
  else if (event.key === 'c' && !embedded) toggleSubtitles();
  else if (event.key === ' ' && !embedded) {
    event.preventDefault();
    video?.paused ? video.play().catch(() => {}) : video?.pause();
  } else if (event.key === 'f') {
    event.preventDefault();
    document.getElementById('player')?.requestFullscreen?.().catch(() => {});
  } else if (event.key === 'm' && video && !embedded) {
    video.muted = !video.muted;
    toast(video.muted ? 'muted' : 'sound on');
  }
});

window.addEventListener('hashchange', () => {
  view.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  // route() bumps viewSeq; capture the value it will take so a later click can
  // suppress this route's error message too
  const seq = state.viewSeq + 1;
  route().catch((err) => {
    render(
      `<div class="empty"><h2>route broke</h2><p>${esc(err.message)}</p>
      <a class="btn ghost" href="#/">go home</a></div>`,
      seq,
    );
  });
});

window.addEventListener('beforeunload', () => {
  const video = document.getElementById('video');
  if (video && state.media && state.ep) saveProgress(video.currentTime, video.duration || 0);
});

route().catch((err) => {
  render(`<div class="empty"><h2>bench offline</h2><p>${esc(err.message)}</p>
    <button class="btn primary" data-retry="home">retry</button></div>`);
});
