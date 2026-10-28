import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { api, ApiError, HUB_UNREACHABLE, workspaceStatus } from '../web/api.js';
import { connectWorkspace } from '../web/connection.js';
import { ConnectionNotice, WorkspaceUnavailable } from '../web/ConnectionNotice.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('network errors and HTML gateway failures give actionable machine connection errors', async t => {
  for (const status of [502, 503, 504]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>Bad Gateway</html>', { status }));
    await assert.rejects(api('me'), (e: ApiError) => e.status === status && e.message === HUB_UNREACHABLE);
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(api('me'), { message: HUB_UNREACHABLE });
});

test('requests time out rather than leave startup hanging', async t => {
  t.mock.method(globalThis, 'fetch', (_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  await assert.rejects(api('me', undefined, 5), { message: HUB_UNREACHABLE });
});

test('response-body stalls are also bounded', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => ({
    ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }));
  await assert.rejects(api('me', undefined, 5), { message: HUB_UNREACHABLE });
});

test('only unauthorized sessions lead to login, not network or proxy errors', async t => {
  const status = JSON.stringify({ twoFactorEnabled: true });
  t.mock.method(globalThis, 'fetch', async (url: string) => url.endsWith('auth/status')
    ? new Response(status) : new Response('Unauthorized', { status: 401 }));
  assert.deepEqual(await workspaceStatus(), { twoFactorEnabled: true, authenticated: false });
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('Bad Gateway', { status: 502 }));
  await assert.rejects(workspaceStatus(), { message: HUB_UNREACHABLE });
});

test('normal API errors and successful authentication retain their meaning', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"error":"Invalid password"}', { status: 401 }));
  await assert.rejects(api('login', { password: 'wrong' }), (e: ApiError) => e.status === 401 && e.message === 'Invalid password');
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('{"twoFactorEnabled":false}'));
  assert.deepEqual(await workspaceStatus(), { twoFactorEnabled: false, authenticated: true });
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Not Hub</html>'));
  await assert.rejects(api('me'), /unexpected response/);
});

class Socket {
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: MessageEvent) => void;
  closed = false;
  close() { this.closed = true; this.onclose?.(); }
}
function harness(checkSession: () => Promise<unknown> = async () => ({})) {
  const sockets: Socket[] = [], events: string[] = [];
  const stop = connectWorkspace({
    createSocket: () => { const ws = new Socket(); sockets.push(ws); return ws as unknown as WebSocket; },
    checkSession,
    onSocket: () => {}, onOpen: () => events.push('open'), onMessage: () => events.push('message'),
    onDisconnect: () => events.push('disconnected'), onExpired: () => events.push('expired'),
  });
  return { sockets, events, stop };
}

test('a stalled WebSocket handshake fails visibly and retries; cleanup stops retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); t.after(h.stop);
  t.mock.timers.tick(12_000); await flush();
  assert.deepEqual(h.events, ['disconnected']); assert.equal(h.sockets[0].closed, true);
  t.mock.timers.tick(1000); assert.equal(h.sockets.length, 2);
  h.stop(); t.mock.timers.tick(60_000); assert.equal(h.sockets.length, 2);
});

test('a sleeping host is detected even when the browser socket never closes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reachable = true;
  const h = harness(async () => { if (!reachable) throw new ApiError(HUB_UNREACHABLE); }); t.after(h.stop);
  h.sockets[0].onopen!(); reachable = false;
  t.mock.timers.tick(15_000); await flush();
  assert.deepEqual(h.events, ['open', 'disconnected']);
  reachable = true; t.mock.timers.tick(1000); h.sockets[1].onopen!();
  assert.deepEqual(h.events, ['open', 'disconnected', 'open']);
  h.sockets[0].onmessage!({} as MessageEvent);
  assert.equal(h.events.includes('message'), false, 'stale socket events are ignored');
});

test('expired sessions return to login rather than retry forever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(async () => { throw new ApiError('Unauthorized', 401); }); t.after(h.stop);
  h.sockets[0].onopen!(); t.mock.timers.tick(15_000); await flush();
  assert.deepEqual(h.events, ['open', 'disconnected', 'expired']);
  t.mock.timers.tick(60_000); assert.equal(h.sockets.length, 1);
});

test('manual refresh/cleanup ignores in-flight health results from old connections', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reject!: (error: Error) => void;
  const h = harness(() => new Promise((_resolve, fail) => { reject = fail; }));
  h.sockets[0].onopen!(); t.mock.timers.tick(15_000); h.stop();
  reject(new ApiError('Unauthorized', 401)); await flush();
  assert.deepEqual(h.events, ['open']);
});

test('cached PWA navigation survives gateway errors and network failures without caching API responses', async () => {
  const source = await readFile(new URL('../web/public/sw.js', import.meta.url), 'utf8');
  for (const failure of [502, 503, 504, 'offline'] as const) {
    let onFetch!: (event: { request: { url: string; method: string; mode: string }; respondWith: (response: Promise<Response>) => void }) => void;
    let matches = 0;
    runInNewContext(source, {
      self: { location: { origin: 'https://hub.example.com' }, addEventListener: (name: string, handler: typeof onFetch) => { if (name === 'fetch') onFetch = handler; } },
      URL, AbortController, Response, setTimeout, clearTimeout,
      fetch: async () => { if (failure === 'offline') throw new Error('offline'); return new Response('gateway failure', { status: failure }); },
      caches: { match: async () => { matches++; return new Response('cached public shell'); } },
    });
    let response!: Promise<Response>;
    const respondWith = (value: Promise<Response>) => { response = value; };
    onFetch({ request: { url: 'https://hub.example.com/', method: 'GET', mode: 'navigate' }, respondWith });
    assert.equal(await (await response).text(), 'cached public shell');
    assert.equal(matches, 1);
    for (const route of ['/api/me', '/ws', '/agent']) {
      onFetch({ request: { url: `https://hub.example.com${route}`, method: 'GET', mode: 'navigate' }, respondWith: () => assert.fail('private endpoint must bypass service worker') });
    }
    assert.equal(matches, 1);
  }
});

test('proxy fallback works without scripts or a reachable backend', async () => {
  const html = await readFile(new URL('../deploy/unavailable.html', import.meta.url), 'utf8');
  assert.match(html, /Workspace unavailable/); assert.match(html, /Refresh/);
  assert.match(html, /<form action="\/" method="get">/); assert.doesNotMatch(html, /<script|<link|<img/);
  const config = await readFile(new URL('../deploy/nginx.example.conf', import.meta.url), 'utf8');
  assert.match(config, /error_page 502 503 504 =503 \/pi-hub-unavailable.html/);
  assert.match(config, /proxy_intercept_errors on/);
});

test('connection notices include refresh and distinguish connecting from unavailable', () => {
  const render = (failed: boolean) => renderToStaticMarkup(createElement(ConnectionNotice, { failed, refresh() {} }));
  assert.match(render(false), /Connecting to Pi Hub/); assert.doesNotMatch(render(false), /connection lost/);
  const lost = render(true);
  for (const text of ['role="alert"', 'machine is awake', 'Retrying automatically', 'out of date', 'not resent', 'Refresh']) assert.ok(lost.includes(text), text);
  const unavailable = renderToStaticMarkup(createElement(WorkspaceUnavailable, { message: HUB_UNREACHABLE, refresh() {} }));
  assert.match(unavailable, /Workspace unavailable/); assert.match(unavailable, /Refresh/);
  assert.doesNotMatch(unavailable, /Workspace password/);
});
