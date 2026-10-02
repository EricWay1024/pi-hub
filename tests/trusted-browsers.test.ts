import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createConfig } from '../server/config.js';
import { createHub } from '../server/hub.js';
import { hashRecovery, newEnrollment, recoveryCodes } from '../server/two-factor.js';
import { newTrustedBrowser, trustedBrowser, TRUST_LIFETIME } from '../server/trusted-browsers.js';

function nextRecord(ws: WebSocket, match: (record: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ws.off('message', message); ws.off('close', closed); };
    const message = (raw: any) => { const record = JSON.parse(raw.toString()); if (match(record)) { cleanup(); resolve(record); } };
    const closed = () => { cleanup(); reject(new Error('Socket closed before command reply')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Missing command reply')); }, 3000);
    ws.on('message', message); ws.on('close', closed);
  });
}

test('browser trust expires absolutely and is bound to password, authenticator, and origin', () => {
  const config = createConfig('test-password-long', tmpdir());
  assert.throws(() => newTrustedBrowser(config, 'Chrome/123'), /Enable 2FA/);
  config.twoFactor = { secret: newEnrollment().secret, lastUsedStep: -1, recoveryHashes: [] };
  const device = newTrustedBrowser(config, 'Mozilla Chrome/123 Linux', 1000); config.trustedBrowsers = device.records;
  assert.equal(trustedBrowser(config, device.token, 1001)?.label, 'Chrome · Linux');
  assert.equal(trustedBrowser(config, device.token, 1000 + TRUST_LIFETIME), undefined);
  assert.ok(!JSON.stringify(config).includes(device.token));
  const oldHash = config.passwordHash; config.passwordHash = 'different'; assert.equal(trustedBrowser(config, device.token, 1001), undefined);
  config.passwordHash = oldHash; const oldSecret = config.twoFactor.secret;
  config.twoFactor.secret = newEnrollment().secret; assert.equal(trustedBrowser(config, device.token, 1001), undefined);
  config.twoFactor.secret = oldSecret; config.origin = 'https://other.test'; assert.equal(trustedBrowser(config, device.token, 1001), undefined);
});
test('remembered login requires 2FA, survives restart, hides token hashes, and revokes open sockets', async () => {
  const config = createConfig('test-password-long', tmpdir()); config.port = 0; config.origin = 'https://hub.test';
  const codes = recoveryCodes(); config.twoFactor = { secret: newEnrollment().secret, lastUsedStep: -1, recoveryHashes: codes.map(hashRecovery) };
  let saved = JSON.stringify(config), hub = createHub(config, { persistConfig: c => { saved = JSON.stringify(c); } });
  let browser: WebSocket | undefined, agent: WebSocket | undefined;
  async function start() { hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening'); return `http://127.0.0.1:${(hub.server.address() as any).port}`; }
  let base = await start();
  const post = (route: string, data: unknown, cookie = '') => fetch(base + '/api/' + route, { method: 'POST', headers: { Origin: 'https://hub.test', Cookie: cookie }, body: JSON.stringify(data) });
  const me = (cookie: string) => fetch(base + '/api/me', { headers: { Cookie: cookie } });
  try {
    assert.equal((await post('login', { password: 'test-password-long', trustBrowser: true })).status, 401);
    assert.equal(config.trustedBrowsers, undefined);
    const login = await post('login', { password: 'test-password-long', recoveryCode: codes[0], trustBrowser: true }); assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]; assert.match(login.headers.get('set-cookie')!, /Max-Age=2592000/); assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/); assert.match(login.headers.get('set-cookie')!, /Secure/);
    assert.equal((await me(cookie)).status, 200);
    const listing = await (await fetch(base + '/api/auth/trusted', { headers: { Cookie: cookie } })).json();
    assert.equal(listing.browsers.length, 1); assert.equal(listing.browsers[0].current, true);
    assert.ok(!JSON.stringify(listing).includes('hash')); assert.ok(!saved.includes(cookie.split('=')[1]));
    await hub.close();
    const restored = JSON.parse(saved); hub = createHub(restored, { persistConfig: c => { saved = JSON.stringify(c); } }); base = await start();
    assert.equal((await me(cookie)).status, 200);
    const normal = await post('login', { password: 'test-password-long', recoveryCode: codes[1] }); const normalCookie = normal.headers.get('set-cookie')!.split(';')[0]; assert.match(normal.headers.get('set-cookie')!, /Max-Age=43200/);
    agent = new WebSocket(base.replace('http:', 'ws:') + '/agent', { headers: { Authorization: 'Bearer ' + restored.agentToken } }); await once(agent, 'open');
    const received: any[] = [];
    agent.on('message', raw => {
      const record = JSON.parse(raw.toString()); if (record.type !== 'command') return;
      received.push(record.command);
      agent!.send(JSON.stringify({ type: 'response', id: record.command.id, success: true, data: { commands: [] } }));
    });
    agent.send(JSON.stringify({ type: 'register', id: 'trusted-agent', metadata: { name: 'Trusted-browser command test', host: 'Test' } }));
    browser = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Origin: 'https://hub.test', Cookie: cookie } });
    const registered = nextRecord(browser, r => r.type === 'agents' && r.agents.some((a: any) => a.id === 'trusted-agent'));
    await once(browser, 'open'); await registered;
    for (const command of [{ type: 'get_commands' }, { type: 'prompt', message: 'Send from a trusted browser after restart' }]) {
      const id = command.type, reply = nextRecord(browser, r => r.type === 'reply' && r.id === id);
      browser.send(JSON.stringify({ type: 'command', id, agentId: 'trusted-agent', command }));
      assert.equal((await reply).success, true);
    }
    assert.ok(received.some(c => c.type === 'prompt' && c.message === 'Send from a trusted browser after restart'));
    const closed = once(browser, 'close');
    assert.equal((await post('auth/trusted/revoke', { id: listing.browsers[0].id }, normalCookie)).status, 200);
    const countBeforeRevoke = received.length;
    browser.send(JSON.stringify({ type: 'command', id: 'revoked-command', agentId: 'trusted-agent', command: { type: 'prompt', message: 'Must not be delivered after revocation' } }));
    await closed; assert.equal(received.length, countBeforeRevoke);
    assert.equal((await me(cookie)).status, 401); assert.equal((await me(normalCookie)).status, 200);
    const second = await post('login', { password: 'test-password-long', recoveryCode: codes[2], trustBrowser: true }); const secondCookie = second.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await post('logout', {}, secondCookie)).status, 200); assert.equal((await me(secondCookie)).status, 401);
    assert.equal(JSON.parse(saved).trustedBrowsers.length, 0);
  } finally { browser?.terminate(); agent?.terminate(); await hub.close(); }
});
test('untrusted enrollment/password-only sessions cannot mint browser trust', async () => {
  const config = createConfig('test-password-long', tmpdir()); config.port = 0;
  const hub = createHub(config); hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening'); config.port = (hub.server.address() as any).port;
  const origin = `http://127.0.0.1:${config.port}`;
  try {
    const response = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ password: 'test-password-long', trustBrowser: true }) });
    assert.equal(response.status, 400); assert.equal(config.trustedBrowsers, undefined);
  } finally { await hub.close(); }
});
