// Cache public application assets only. Never cache API responses or conversations.
const CACHE = 'pi-hub-shell-v2';
self.addEventListener('install', event => { self.skipWaiting(); event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/', '/icon.svg', '/manifest.webmanifest']))); });
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/agent') return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(event.request, { signal: controller.signal });
        // A reachable proxy can still mean an unreachable machine. Load the
        // cached shell so it can show the connection error and Refresh button.
        if ([502, 503, 504].includes(response.status)) return await caches.match('/') || response;
        return response;
      } catch {
        return await caches.match('/') || new Response('Pi Hub is unreachable. Check that your machine is awake and Pi Hub and its tunnel are running, then refresh.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      } finally { clearTimeout(timer); }
    })()); return;
  }
  if (url.pathname.startsWith('/assets/') || /\.(png|svg|webmanifest)$/.test(url.pathname)) event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(event.request); if (cached) return cached;
    const response = await fetch(event.request); if (response.ok) await cache.put(event.request, response.clone()); return response;
  }));
});
