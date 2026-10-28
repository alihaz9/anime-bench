// Stream proxy: HLS manifests get their URIs rewritten through this route,
// segments are piped through with the provider's Referer attached.
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];
const PRIVATE_V6 = [/^::1?$/, /^f[cd][0-9a-f]{2}:/i, /^fe[89ab][0-9a-f]:/i, /^::ffff:/i];

function isPrivateAddress(address) {
  if (!net.isIP(address)) return true;
  if (net.isIPv4(address)) return PRIVATE_V4.some((re) => re.test(address));
  return PRIVATE_V6.some((re) => re.test(address));
}

// Small DNS cache so a segment run doesn't resolve per request.
const dnsCache = new Map();
const DNS_TTL_MS = 60_000;

async function resolveHost(hostname) {
  const hit = dnsCache.get(hostname);
  if (hit && hit.expires > Date.now()) return hit.addresses;

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('blocked host');
    return [hostname];
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  const addresses = records.map((r) => r.address);
  if (!addresses.length) throw new Error('dns empty');
  if (addresses.some(isPrivateAddress)) throw new Error('blocked host');

  if (dnsCache.size > 500) dnsCache.clear();
  dnsCache.set(hostname, { addresses, expires: Date.now() + DNS_TTL_MS });
  return addresses;
}

async function validate(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error('bad url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
  if (url.username || url.password) throw new Error('bad url');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw new Error('blocked host');
  await resolveHost(url.hostname);
  return url;
}

function upstreamHeaders(referer) {
  const headers = {
    'user-agent': USER_AGENT,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
  };
  if (referer) {
    headers.referer = referer;
    try {
      headers.origin = new URL(referer).origin;
    } catch {
      /* referer was junk, send without origin */
    }
  }
  return headers;
}

function proxyLink(target, referer) {
  const ref = referer ? `&ref=${encodeURIComponent(referer)}` : '';
  return `/api/stream?url=${encodeURIComponent(target.href)}${ref}`;
}

function rewriteManifest(text, baseUrl, referer) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('#')) {
        return trimmed.replace(/URI="([^"]+)"/g, (_match, uri) => {
          try {
            return `URI="${proxyLink(new URL(uri, baseUrl), referer)}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }
      try {
        return proxyLink(new URL(trimmed, baseUrl), referer);
      } catch {
        return trimmed;
      }
    })
    .join('\n');
}

async function readCapped(response, limit) {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > limit) throw new Error('upstream too large');

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw new Error('upstream too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function streamProxy(req, res) {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
  const referer = typeof req.query.ref === 'string' ? req.query.ref.slice(0, 2048) : '';

  let url;
  try {
    url = await validate(rawUrl);
  } catch (err) {
    res.status(400).json({ error: err.message || 'bad url' });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(url, {
      headers: upstreamHeaders(referer),
      redirect: 'follow',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    res.status(502).json({ error: 'upstream unreachable' });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    res.status(502).json({ error: `upstream ${upstream.status}` });
    return;
  }

  const finalUrl = new URL(upstream.url || url.href);
  const contentType = upstream.headers.get('content-type') || '';
  const looksLikeManifest =
    /mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(finalUrl.href) || /\.m3u8(\?|$)/i.test(url.href);

  if (looksLikeManifest) {
    try {
      const buffer = await readCapped(upstream, MAX_MANIFEST_BYTES);
      const body = rewriteManifest(buffer.toString('utf8'), finalUrl, referer);
      res.set('content-type', 'application/vnd.apple.mpegurl');
      res.set('cache-control', 'no-store');
      res.set('access-control-allow-origin', '*');
      res.send(body);
    } catch (err) {
      res.status(502).json({ error: err.message || 'manifest failed' });
    }
    return;
  }

  const declared = Number(upstream.headers.get('content-length') ?? 0);
  if (declared > MAX_SEGMENT_BYTES) {
    res.status(502).json({ error: 'upstream too large' });
    return;
  }

  res.status(200);
  if (contentType) res.set('content-type', contentType);
  const length = upstream.headers.get('content-length');
  if (length) res.set('content-length', length);
  res.set('cache-control', 'public, max-age=120');
  res.set('access-control-allow-origin', '*');

  const source = Readable.fromWeb(upstream.body);
  let sent = 0;
  source.on('data', (chunk) => {
    sent += chunk.length;
    if (sent > MAX_SEGMENT_BYTES) source.destroy(new Error('segment too large'));
  });
  source.on('error', () => res.destroy());
  req.on('close', () => source.destroy());
  source.pipe(res);
}
