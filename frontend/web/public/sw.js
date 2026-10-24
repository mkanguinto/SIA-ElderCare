// Service worker: makes ElderCare installable, lets the app shell open with no signal (check-ins made offline
// wait in the outbox and send later), and opens the right screen when a reminder notification is tapped.
// API calls are never cached: health data always comes fresh from the gateway.
const SHELL = 'eldercare-shell-v1';
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/brand/logo.png',
  '/brand/walk-1.svg', '/brand/walk-2.svg', '/brand/walk-3.svg', '/brand/walk-4.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // the gateway is another origin
  if (req.mode === 'navigate') {
    // Pages: network first, the cached shell when offline (the app routes on the client).
    event.respondWith(fetch(req).then((res) => {
      caches.open(SHELL).then((c) => c.put('/index.html', res.clone()));
      return res;
    }).catch(() => caches.match('/index.html')));
    return;
  }
  // Built assets (hashed names) and images: cache first, then network.
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/brand/') || url.pathname.startsWith('/icons/'))) {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(req, copy));
    }
    return res;
  })));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) return open.focus().then(() => open.navigate(target));
    return self.clients.openWindow(target);
  }));
});
