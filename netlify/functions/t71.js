/**
 * t71.js — same-origin API proxy for the Tuition71 admin panel.
 *
 * WHAT CHANGED (2026-11-12)
 * ---------------------------------------------------------------------------
 * The backend moved. The old hosts this function talked to are dead:
 *   tuition-seba-backend-production-da93.up.railway.app  -> HTTP 404
 *     {"status":"error","code":404,"message":"Application not found"}
 *   tuition-seba-backend-1.onrender.com                  -> HTTP 503
 *     "This service has been suspended."
 * The live API is now:  https://api.tuitionsebaforum.com
 * (that is the host the public site's own bundle calls).
 *
 * WHY A PROXY IS STILL REQUIRED
 * ---------------------------------------------------------------------------
 * api.tuitionsebaforum.com answers HTTP 500 (empty body, no CORS headers) to
 * any request that carries an Origin header, so the browser cannot call it
 * directly from admin71.netlify.app. This function calls it server-side with
 * no Origin/Referer, which the API accepts normally.
 *
 * ROUTE MAPPING (see netlify.toml)
 * ---------------------------------------------------------------------------
 *   /api/tuition/*       -> ?__p=tuition/<rest>
 *   /api/tuitionApply/*  -> ?__p=tuitionApply/<rest>
 *   /api/t71-health      -> ?__health=1   (diagnostics, open in a browser)
 */

const DEFAULT_UPSTREAM = 'https://api.tuitionsebaforum.com';

// Ordered failover list. Index 0 is the live host; the legacy hosts are kept
// last only so a future flip back needs no code change. Set the Netlify env
// var T71_UPSTREAM to point the whole panel somewhere else without a redeploy.
const UPSTREAMS = [
  process.env.T71_UPSTREAM || DEFAULT_UPSTREAM,
  'https://tuition-seba-backend-production-da93.up.railway.app',
  'https://tuition-seba-backend-1.onrender.com',
].filter(Boolean);

// Hard allow-list: even a direct hit on /.netlify/functions/t71 cannot reach
// any route outside these prefixes.
const ALLOWED_PREFIXES = ['/api/tuition', '/api/tuitionApply'];

const TIMEOUT_MS = 25000;

// Headers that must never be forwarded upstream.
const DROP = new Set([
  'host', 'connection', 'content-length', 'accept-encoding',
  'x-nf-client-connection-ip', 'x-forwarded-for', 'x-forwarded-proto',
  'x-forwarded-host', 'x-nf-request-id', 'x-nf-account-id',
  'x-nf-site-id', 'x-nf-deploy-id', 'cdn-loop',
  'origin', 'referer',                        // the whole point: no Origin upstream
]);

// Bodies that mean "this host is gone", not "this record is missing".
const DEAD_HOST_RE = /Application not found|Service Suspended|service has been suspended/i;

exports.handler = async function (event) {
  const qs = event.queryStringParameters || {};

  // ---- diagnostics mode -------------------------------------------------
  if (qs.__health) return health();

  // ---- resolve the upstream path ---------------------------------------
  let upstreamPath = null;
  if (qs.__p) upstreamPath = '/api/' + String(qs.__p).replace(/^\/+/, '');

  if (!upstreamPath && event.rawUrl) {
    try {
      const p = new URL(event.rawUrl).pathname;
      if (p.indexOf('/api/') === 0) upstreamPath = p;
      else {
        const m = p.match(/\/\.netlify\/functions\/t71\/(.+)$/);
        if (m) upstreamPath = '/api/' + m[1];
      }
    } catch (e) { /* ignore */ }
  }
  if (!upstreamPath && event.path) {
    const m = String(event.path).match(/\/\.netlify\/functions\/t71\/(.+)$/);
    if (m) upstreamPath = '/api/' + m[1];
    else if (event.path.indexOf('/api/') === 0) upstreamPath = event.path;
  }

  if (!upstreamPath) {
    return json(400, { error: 'could not resolve the requested path', path: event.path || null });
  }
  if (!ALLOWED_PREFIXES.some((p) => upstreamPath === p || upstreamPath.startsWith(p + '/') || upstreamPath.startsWith(p + '?'))) {
    return json(403, { error: 'path not proxied', path: upstreamPath });
  }

  // ---- preserve the caller's query string, minus our carrier params -----
  let query = '';
  try {
    const src = event.rawUrl ? new URL(event.rawUrl).search : '';
    const sp = new URLSearchParams(src);
    sp.delete('__p');
    sp.delete('__health');
    const s = sp.toString();
    if (s) query = '?' + s;
  } catch (e) { /* fall through to manual build */ }
  if (!query) {
    const passthrough = Object.keys(qs)
      .filter((k) => k !== '__p' && k !== '__health')
      .map((k) => k + '=' + encodeURIComponent(qs[k] === undefined ? '' : qs[k]))
      .join('&');
    if (passthrough) query = '?' + passthrough;
  }

  const method = (event.httpMethod || 'GET').toUpperCase();

  // ---- forward-safe headers --------------------------------------------
  const headers = { accept: 'application/json, text/plain, */*' };
  for (const [k, v] of Object.entries(event.headers || {})) {
    if (!DROP.has(k.toLowerCase())) headers[k] = v;
  }

  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : event.body
        ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body)
        : undefined;

  const attempts = [];

  for (const base of UPSTREAMS) {
    const target = base.replace(/\/+$/, '') + upstreamPath + query;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(target, { method, headers, body, redirect: 'follow', signal: ctl.signal });
      clearTimeout(timer);

      const text = await res.text();

      if (res.status >= 500 || (res.status === 404 && DEAD_HOST_RE.test(text))) {
        attempts.push({ host: base, status: res.status, dead: true, detail: text.slice(0, 200) });
        continue;                                     // try the next host
      }

      return {
        statusCode: res.status,
        headers: {
          'content-type': res.headers.get('content-type') || 'application/json; charset=utf-8',
          'cache-control': 'no-store, no-cache, must-revalidate',
          'x-t71-upstream': base,
          // Same-origin: no CORS headers needed, so none are added.
        },
        body: text,
      };
    } catch (e) {
      clearTimeout(timer);
      attempts.push({
        host: base,
        status: 0,
        detail: e && e.name === 'AbortError'
          ? 'timeout after ' + Math.round(TIMEOUT_MS / 1000) + 's'
          : String((e && e.message) || e),
      });
    }
  }

  return json(502, {
    error: 'no upstream answered',
    path: upstreamPath,
    tried: attempts,
    hint: 'If every host reports 404 "Application not found" or 503 "Service Suspended", '
        + 'the backend has moved again: open /api/t71-health, find the live host, then set '
        + 'the Netlify env var T71_UPSTREAM (no code change needed).',
  });
};

/**
 * Probe every upstream and report which one is alive. Open
 * https://admin71.netlify.app/api/t71-health in a browser to see this.
 */
async function health() {
  const probePath = '/api/tuition/getTableData?tuitionCode=17807';
  const out = [];
  for (const base of UPSTREAMS) {
    const started = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    let row = { host: base, ok: false };
    try {
      const res = await fetch(base.replace(/\/+$/, '') + probePath, {
        headers: { accept: 'application/json', 'user-agent': 'toj-admin-proxy/2' },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { /* not json */ }
      row.status = res.status;
      row.ms = Date.now() - started;
      row.ok = res.status === 200 && !!(parsed && (parsed.data || Array.isArray(parsed)));
      row.sample = parsed && parsed.data && parsed.data[0]
        ? { tuitionCode: parsed.data[0].tuitionCode, status: parsed.data[0].status, salary: parsed.data[0].salary }
        : null;
      if (!row.ok) row.detail = text.slice(0, 200);
    } catch (e) {
      clearTimeout(timer);
      row.status = 0;
      row.ms = Date.now() - started;
      row.detail = e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e);
    }
    out.push(row);
  }
  return json(200, {
    ok: out.some((r) => r.ok),
    active: (out.find((r) => r.ok) || {}).host || null,
    configured_primary: UPSTREAMS[0],
    checked_at: new Date().toISOString(),
    hosts: out,
  });
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(obj, null, 2),
  };
}
