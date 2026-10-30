/**
 * t71.js — same-origin API proxy for the Tuition71 admin panel.
 *
 * WHY: the backend only answers origins on its CORS allow-list.
 * https://admin71.netlify.app is NOT on it, so the browser receives 500 with
 * no Access-Control-Allow-Origin and reports "blocked by CORS policy".
 * This function runs on the SAME origin as the panel, so the browser never
 * makes a cross-origin request; the function calls the API server-side, where
 * no Origin header is sent and no CORS check applies. No backend change.
 *
 * REACHED VIA (see netlify.toml) — only these two prefixes are rewritten, so
 * no other /api/* route on this site is affected:
 *   /api/tuition/*      -> ?__p=tuition/<rest>
 *   /api/tuitionApply/* -> ?__p=tuitionApply/<rest>
 */

const UPSTREAM_PRIMARY =
  'https://tuition-seba-backend-production-da93.up.railway.app';
const UPSTREAM_SECONDARY =
  'https://tuition-seba-backend-1.onrender.com';

// Hard allow-list, independent of the rewrite: even a direct call to
// /.netlify/functions/t71 cannot reach a token-only route.
const ALLOWED_PREFIXES = ['/api/tuition', '/api/tuitionApply'];

const TIMEOUT_MS = 45000;

const DROP = new Set([
  'host', 'connection', 'content-length', 'accept-encoding',
  'x-nf-client-connection-ip', 'x-forwarded-for', 'x-forwarded-proto',
  'x-forwarded-host', 'x-nf-request-id', 'x-nf-account-id',
  'x-nf-site-id', 'x-nf-deploy-id', 'cdn-loop',
  'origin', 'referer',                 // the point: no Origin upstream
]);

exports.handler = async function (event) {
  const qs = event.queryStringParameters || {};

  // Path comes from ?__p=tuition/getTableData set by the rewrite.
  let upstreamPath = null;
  if (qs.__p) upstreamPath = '/api/' + String(qs.__p).replace(/^\/+/, '');

  // Fallbacks, in case a request reaches the function some other way.
  if (!upstreamPath && event.rawUrl) {
    try {
      const p = new URL(event.rawUrl).pathname;
      if (p.indexOf('/api/') === 0) upstreamPath = p;
      else {
        const m = p.match(/\/\.netlify\/functions\/t71\/(.+)$/);
        if (m) upstreamPath = '/api/' + m[1];
      }
    } catch (e) {}
  }
  if (!upstreamPath && event.path) {
    const m = String(event.path).match(/\/\.netlify\/functions\/t71\/(.+)$/);
    if (m) upstreamPath = '/api/' + m[1];
    else if (event.path.indexOf('/api/') === 0) upstreamPath = event.path;
  }

  if (!upstreamPath) {
    return json(400, {
      error: 'could not resolve the requested path',
      path: event.path || null,
      query: qs,
    });
  }

  if (!ALLOWED_PREFIXES.some((p) => upstreamPath.startsWith(p))) {
    return json(403, { error: 'path not proxied', path: upstreamPath });
  }

  // Forward the caller's query string, minus our internal __p carrier.
  const passthrough = Object.keys(qs)
    .filter((k) => k !== '__p')
    .map((k) => k + '=' + encodeURIComponent(qs[k] === undefined ? '' : qs[k]))
    .join('&');
  const query = passthrough ? '?' + passthrough : '';

  const method = (event.httpMethod || 'GET').toUpperCase();

  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    if (!DROP.has(k.toLowerCase())) headers[k] = v;
  }

  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : event.body
        ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body)
        : undefined;

  let lastStatus = 0;
  let lastDetail = '';

  for (const base of [UPSTREAM_PRIMARY, UPSTREAM_SECONDARY]) {
    const target = base + upstreamPath + query;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(target, {
        method, headers, body, redirect: 'follow', signal: ctl.signal,
      });
      clearTimeout(timer);

      if ([502, 503, 504].includes(res.status)) {
        lastStatus = res.status;
        lastDetail = (await res.text()).slice(0, 300);
        continue;                                   // try the mirror
      }

      const text = await res.text();
      return {
        statusCode: res.status,
        headers: {
          'content-type': res.headers.get('content-type') || 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          // Same-origin: no CORS headers needed, none added.
        },
        body: text,
      };
    } catch (e) {
      clearTimeout(timer);
      lastStatus = 0;
      lastDetail =
        e && e.name === 'AbortError'
          ? 'timeout after ' + Math.round(TIMEOUT_MS / 1000) + 's'
          : String((e && e.message) || e);
    }
  }

  return json(502, {
    error: 'upstream unreachable',
    path: upstreamPath,
    last_status: lastStatus,
    detail: lastDetail,
    tried: [UPSTREAM_PRIMARY, UPSTREAM_SECONDARY],
    hint: 'last_status 503 = backend down/asleep. last_status 0 = no network reachability.',
  });
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(obj),
  };
}
