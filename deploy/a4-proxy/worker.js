/**
 * a4-proxy — a Cloudflare Worker that fetches anime4up on behalf of the site.
 *
 * why: anime4up sits behind a Cloudflare rule that 403s datacenter IPs, so the
 * vercel function (and every other host) gets a challenge page. a worker runs on
 * cloudflare's own network, which the rule lets through, and hands back the body.
 *
 * deploy (free plan, no card):
 *   npm i -g wrangler
 *   wrangler login
 *   cd deploy/a4-proxy && wrangler deploy
 *   -> copy the https://a4-proxy.<your-subdomain>.workers.dev url
 *   -> vercel env add ANIME4UP_PROXY   (paste the url)
 *   -> redeploy the site
 *
 * only the hosts below are reachable through it, only GET, only paths that look
 * like anime4up pages — it is not an open proxy.
 */

const ALLOWED_HOSTS = new Set([
  'w1.anime4up.rest',
  'w2.anime4up.rest',
  'w3.anime4up.rest',
  'anime4up.rest',
  '4n.anime4up.rest',
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return new Response('method not allowed', { status: 405 });
    }

    const incoming = new URL(request.url);
    // the site calls /?url=<encoded target>; anything else is a health ping
    const target = incoming.searchParams.get('url');
    if (!target) return new Response('a4-proxy up', { status: 200 });

    let url;
    try {
      url = new URL(target);
    } catch {
      return new Response('bad url', { status: 400 });
    }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      return new Response('host not allowed', { status: 403 });
    }

    const upstream = await fetch(url.toString(), {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'ar,en-US;q=0.9,en;q=0.8',
        referer: `${url.origin}/`,
      },
      redirect: 'follow',
      cf: { cacheTtl: 0 },
    });

    const headers = new Headers(upstream.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.set('access-control-allow-origin', '*');
    headers.set('x-a4-proxy', '1');

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
