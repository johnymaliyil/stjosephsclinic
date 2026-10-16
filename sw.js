const CACHE_NAME = 'stjosephsclinic-shell-v1';
const SHELL_URL = './index.html';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.add(SHELL_URL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first: always prefer the live site so a deploy is never masked by a
// stale cache; the cached shell is only used as an offline fallback.
// cache:'no-cache' always revalidates with the server (so a deploy is never
// masked by a browser cache that still looks "fresh" by max-age) but lets the
// server answer with a cheap 304 when nothing changed, instead of forcing a
// full re-download of this ~400KB single-page file on every load like
// cache:'reload' did -- that turned out to make loads on slower connections
// (e.g. an iPad on clinic wifi) noticeably slower.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match(SHELL_URL)))
  );
});

// Hourly staff reminder notifications carry action buttons (shown via
// registration.showNotification, not the plain Notification constructor, since
// action buttons only work on service-worker-issued notifications). Route a
// click to the right admin screen: focus an already-open tab and hand it the
// action, or open a new tab with the action in the query string if none is open.
self.addEventListener('notificationclick', (event) => {
  const action = event.action || '';
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'staff-reminder-action', action });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(action ? `./?remind=${action}` : './');
      }
    })
  );
});
