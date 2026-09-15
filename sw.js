/* =====================================================================
   Tuition O Job Media -- Admin PWA service worker.
   Flat repo root layout: every file this worker references (admin.html,
   notifications.html, debug.html, icons) lives at "/", not in a subfolder.
   ===================================================================== */

const CACHE_NAME = 'toj-admin-shell-v1';
const SHELL_FILES = [
  '/admin.html',
  '/notifications.html',
  '/debug.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {
      // Don't block install if one shell file is briefly unreachable --
      // push notifications and the debug tool matter more than offline
      // caching working perfectly on first install.
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Network-first for HTML (so admins always see fresh data when online),
// cache-fallback for everything else (so the shell still loads offline).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.headers.get('accept') && req.headers.get('accept').includes('text/html')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req).then((r) => r || caches.match('/admin.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});

/* =====================================================================
   PUSH NOTIFICATIONS
   The send-web-push Netlify function sends a JSON payload shaped like:
     { title, body, kind, ref_type, ref_id, notification_id, url }
   This handler shows it as a system notification and deep-links back
   into notifications.html when tapped, highlighting that specific row.
   ===================================================================== */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Tuition O Job Media', body: event.data ? event.data.text() : 'New notification' };
  }

  const title = data.title || 'Tuition O Job Media';
  const kindIcon = {
    sos: '🆘',
    money: '💰',
    unassigned_tuition: '⏰',
    test: '🔔'
  }[data.kind] || '🔔';

  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.kind && data.ref_id ? (data.kind + '-' + data.ref_id) : undefined,
    renotify: true,
    data: {
      url: data.url || '/notifications.html' + (data.notification_id ? ('?highlight=' + data.notification_id) : ''),
      notification_id: data.notification_id || null
    }
  };

  event.waitUntil(self.registration.showNotification(kindIcon + ' ' + title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/notifications.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
