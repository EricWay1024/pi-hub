import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { Secret } from 'otpauth';
import { createConfig } from '../server/config.js';
import { createHub } from '../server/hub.js';
import { hashRecovery, newEnrollment, recoveryCodes, totp, validTotpStep, verifySecondFactor } from '../server/two-factor.js';

test('TOTP matches RFC 6238, rejects replay, and recovery codes are single-use', () => {
  const secret = Secret.fromUTF8('12345678901234567890').base32; // Public RFC 6238 test vector.
  assert.equal(validTotpStep(secret, '287082', 59_000), 1); // RFC SHA1 vector, six trailing digits.
  assert.equal(validTotpStep(secret, 'not-a-code', 59_000), null);
  const c = createConfig('test-password-long', tmpdir()), codes = recoveryCodes();
  assert.equal(new Set(codes).size, 10);
  c.twoFactor = { secret, lastUsedStep: -1, recoveryHashes: codes.map(hashRecovery) };
  assert.equal(verifySecondFactor(c, '287082', undefined, 59_000), true);
  assert.equal(verifySecondFactor(c, '287082', undefined, 59_000), false);
  assert.equal(verifySecondFactor(c, undefined, codes[0]), true);
  assert.equal(verifySecondFactor(c, undefined, codes[0]), false);
  assert.equal(c.twoFactor.recoveryHashes.length, 9);
  assert.equal(JSON.stringify(c).includes(codes[1]), false);
});
test('enrollment requires password and laptop token, revokes sessions, and requires an unreplayed second factor', async () => {
  const config = createConfig('test-password-long', tmpdir()); config.port = 0;
  const token = 'laptop-only-token'; config.enrollmentHash = hashRecovery(token);
  const persisted: string[] = [];
  const hub = createHub(config, { persistConfig: c => persisted.push(JSON.stringify(c)) });
  hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening'); config.port = (hub.server.address() as any).port;
  const base = `http://127.0.0.1:${config.port}`; config.origin = 'https://hub.test';
  const post = (route: string, body: unknown) => fetch(base + '/api/' + route, { method: 'POST', headers: { Origin: config.origin! }, body: JSON.stringify(body) });
  let browser: WebSocket | undefined;
  try {
    const login = await post('login', { password: 'test-password-long' }); assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]; assert.match(login.headers.get('set-cookie')!, /Secure/); assert.match(login.headers.get('set-cookie')!, /Max-Age=43200/);
    browser = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Origin: config.origin, Cookie: cookie } }); await once(browser, 'open');
    assert.equal((await post('auth/enroll/start', { password: 'test-password-long', setupToken: 'wrong' })).status, 401);
    const started = await post('auth/enroll/start', { password: 'test-password-long', setupToken: token }); assert.equal(started.status, 200);
    const candidate = await started.json(); assert.match(candidate.uri, /^otpauth:\/\/totp\//);
    assert.equal(config.twoFactor, undefined); // Password-only access stays until confirmed.
    assert.equal((await post('auth/enroll/finish', { challenge: candidate.challenge, code: 'invalid' })).status, 401);
    const revoked = once(browser, 'close');
    const finished = await post('auth/enroll/finish', { challenge: candidate.challenge, code: totp(candidate.secret).generate() }); assert.equal(finished.status, 200);
    const recovery = (await finished.json()).recoveryCodes; assert.equal(recovery.length, 10);
    const upgradedCookie = finished.headers.get('set-cookie')!.split(';')[0];
    await revoked;
    assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await fetch(base + '/api/me', { headers: { Cookie: upgradedCookie } })).status, 200);
    assert.equal((await post('login', { password: 'test-password-long' })).status, 401);
    const freshCode = totp(candidate.secret).generate({ timestamp: (config.twoFactor!.lastUsedStep + 1) * 30_000 });
    assert.equal((await post('login', { password: 'test-password-long', code: freshCode })).status, 200);
    assert.equal((await post('login', { password: 'test-password-long', code: freshCode })).status, 401);
    assert.equal((await (await fetch(base + '/api/auth/status')).json()).twoFactorEnabled, true);
    assert.equal(config.enrollmentHash, undefined); assert.ok(persisted.length >= 2);
  } finally { browser?.terminate(); await hub.close(); }
});
test('recovery still requires password, is consumed atomically, and attempts are throttled', async () => {
  const config = createConfig('test-password-long', tmpdir()); config.port = 0;
  const code = recoveryCodes()[0]; config.twoFactor = { secret: newEnrollment().secret, lastUsedStep: -1, recoveryHashes: [hashRecovery(code)] };
  const hub = createHub(config); hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening'); config.port = (hub.server.address() as any).port;
  const origin = `http://127.0.0.1:${config.port}`;
  const login = (password: string) => fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ password, recoveryCode: code }) });
  try {
    assert.equal((await login('wrong-password')).status, 401); assert.equal(config.twoFactor.recoveryHashes.length, 1);
    const results = await Promise.all([login('test-password-long'), login('test-password-long')]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong-password')).status, 401);
    assert.equal((await login('test-password-long')).status, 429);
  } finally { await hub.close(); }
});
test('authenticator guessing is limited across IPs; a valid recovery code remains usable', async () => {
  const config = createConfig('test-password-long', tmpdir()); config.port = 0; config.origin = 'https://hub.test';
  const recovery = recoveryCodes()[0]; config.twoFactor = { secret: newEnrollment().secret, lastUsedStep: -1, recoveryHashes: [hashRecovery(recovery)] };
  const hub = createHub(config); hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening');
  const base = `http://127.0.0.1:${(hub.server.address() as any).port}`;
  const login = (ip: number, secondFactor: object) => fetch(base + '/api/login', { method: 'POST', headers: { Origin: config.origin!, 'X-Real-IP': '10.0.0.' + ip }, body: JSON.stringify({ password: 'test-password-long', ...secondFactor }) });
  try {
    for (let i = 1; i <= 8; i++) assert.equal((await login(i, { code: 'invalid' })).status, 401);
    assert.equal((await login(9, { code: totp(config.twoFactor.secret).generate() })).status, 429);
    assert.equal((await login(10, { recoveryCode: recovery })).status, 200);
  } finally { await hub.close(); }
});
test('failed enrollment persistence does not enable 2FA in memory or revoke the working login', async () => {
  const config = createConfig('test-password-long', tmpdir()); config.port = 0; config.enrollmentHash = hashRecovery('local-token');
  let fail = true;
  const hub = createHub(config, { persistConfig: () => { if (fail) throw new Error('Fixture write failed'); } });
  hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening'); config.port = (hub.server.address() as any).port;
  const base = `http://127.0.0.1:${config.port}`;
  const post = (route: string, data: unknown) => fetch(base + '/api/' + route, { method: 'POST', headers: { Origin: base }, body: JSON.stringify(data) });
  try {
    const initial = await post('login', { password: 'test-password-long' });
    const cookie = initial.headers.get('set-cookie')!.split(';')[0];
    const pending = await (await post('auth/enroll/start', { password: 'test-password-long', setupToken: 'local-token' })).json();
    const completion = { challenge: pending.challenge, code: totp(pending.secret).generate() };
    assert.equal((await post('auth/enroll/finish', completion)).status, 400);
    assert.equal(config.twoFactor, undefined); assert.ok(config.enrollmentHash);
    assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookie } })).status, 200);
    fail = false; assert.equal((await post('auth/enroll/finish', completion)).status, 200);
  } finally { await hub.close(); }
});
