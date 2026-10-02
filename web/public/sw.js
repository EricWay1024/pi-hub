// Cache public application assets only. Never cache API responses or conversations.
const CACHE = 'pi-hub-shell-v1';
self.addEventListener('install', event => { self.skipWaiting(); event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/', '/icon.svg', '/manifest.webmanifest']))); });
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/agent') return;
  if (event.request.mode === 'navigate') { event.respondWith(fetch(event.request).catch(() => caches.match('/'))); return; }
  if (url.pathname.startsWith('/assets/') || /\.(png|svg|webmanifest)$/.test(url.pathname)) event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(event.request); if (cached) return cached;
    const response = await fetch(event.request); if (response.ok) await cache.put(event.request, response.clone()); return response;
  }));
});
