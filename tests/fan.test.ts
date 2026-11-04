import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { createFanControl, FanError, type FanReading } from '../server/fan.js';
import { modesForType } from '../shared/fan.js';
import { createHub } from '../server/hub.js';
import { createConfig } from '../server/config.js';

const reading = (value = 1, type = 'FourLevelMax'): FanReading => ({ model: '17Z90SP-E.AL78C', type, value });
test('LG mode arguments are not the FanModeValue enum; only supported modes are offered', () => {
  assert.deepEqual(modesForType('FourLevelMax').map(m => [m.id, m.value]), [['silent', 0], ['normal', 1], ['performance', 2], ['max', 6]]);
  assert.deepEqual(modesForType('FourLevel').map(m => m.value), [3, 0, 1, 2]);
  assert.deepEqual(modesForType('FivelLevelAuto').map(m => m.value), [5, 3, 0, 1, 2]);
  assert.deepEqual(modesForType('NotSupported'), []);
  assert.deepEqual(modesForType('TwoLevel'), []);
});
test('read status, coalesce/cache reads and confirm writes with fresh hardware data', async () => {
  const calls: (number | undefined)[] = [];
  const fan = createFanControl(async value => { calls.push(value); return reading(value ?? 1); });
  const statuses = await Promise.all([fan.status(), fan.status()]);
  assert.equal(statuses[0].mode, 'normal'); assert.equal(statuses[1].available, true);
  await fan.status(); assert.deepEqual(calls, [undefined]);
  assert.equal((await fan.set('max')).mode, 'max');
  assert.deepEqual(calls, [undefined, undefined, 6]);
});
test('unsupported and failed reads are unavailable, not invented fan states', async () => {
  for (const run of [async () => reading(-1), async () => reading(1, 'TwoLevel'), async () => { throw new Error('private paths'); }]) {
    let calls = 0;
    const fan = createFanControl(async () => { calls++; return run(); });
    const status = await fan.status();
    await fan.status(); assert.equal(calls, 1);
    assert.equal(status.available, false); assert.deepEqual(status.modes, []);
    assert.ok(!JSON.stringify(status).includes('private paths'));
  }
});
test('invalid, unavailable, unsupported, unchanged and unconfirmed changes', async () => {
  const calls: (number | undefined)[] = [];
  const fan = createFanControl(async value => { calls.push(value); return reading(); });
  await assert.rejects(fan.set('$(evil)' as any), (e: FanError) => e.status === 400);
  assert.deepEqual(calls, []);
  await assert.rejects(fan.set('noiseless'), (e: FanError) => e.status === 400);
  assert.deepEqual(calls, [undefined]);
  calls.length = 0;
  assert.equal((await fan.set('normal')).mode, 'normal'); assert.deepEqual(calls, [undefined]);
  await assert.rejects(fan.set('max'), /无法确认/);
  await assert.rejects(createFanControl(async () => reading(-1)).set('normal'));
});
test('serialize hardware operations and release busy lock after failure', async () => {
  let release!: (r: FanReading) => void, calls = 0;
  const fan = createFanControl(async () => { calls++; if (calls === 1) return new Promise(resolve => { release = resolve; }); return reading(); });
  const initial = fan.status();
  const change = fan.set('normal');
  await assert.rejects(fan.set('max'), (e: FanError) => e.status === 409);
  await assert.rejects(fan.status(), (e: FanError) => e.status === 409);
  assert.equal(calls, 1); release(reading());
  await initial; await change;
  assert.equal(calls, 2);
  const failing = createFanControl(async () => { throw new FanError('unavailable'); });
  await assert.rejects(failing.set('max')); assert.equal((await failing.status()).available, false);
});
test('fan HTTP endpoint requires authentication, same origin and allowlisted mode; never accepts commands', async () => {
  let reads = 0, writes = 0;
  const config = createConfig('fan-test-password', tmpdir()); config.port = 0;
  const hub = createHub(config, { fanControl: {
    status: async () => { reads++; return { available: true, model: 'LG', mode: 'normal', modes: modesForType('FourLevelMax') }; },
    set: async mode => { writes++; if (mode === 'max') throw new FanError('Busy', 409); return { available: true, mode, modes: modesForType('FourLevelMax') }; },
  } });
  hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening');
  config.port = (hub.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${config.port}`, endpoint = origin + '/api/laptop/fan';
  try {
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: origin }, body: '{"mode":"normal"}' })).status, 401);
    assert.equal(reads + writes, 0);
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ password: 'fan-test-password' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const headers = { Cookie: cookie, Origin: origin };
    const status = await fetch(endpoint, { headers }); assert.equal(status.status, 200); assert.equal((await status.json()).mode, 'normal');
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{"mode":"normal"}' })).status, 403);
    for (const mode of [null, 6, 'MAX', 'normal; calc.exe', { command: 'calc.exe' }]) {
      assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ mode }) })).status, 400);
    }
    assert.equal(writes, 0);
    for (const body of ['[1]', '{bad', JSON.stringify({ mode: 'normal', padding: 'x'.repeat(1024) })]) {
      assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 400);
    }
    assert.equal(writes, 0);
    const change = await fetch(endpoint, { method: 'POST', headers, body: '{"mode":"performance"}' });
    assert.equal(change.status, 200); assert.equal((await change.json()).mode, 'performance');
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{"mode":"max"}' })).status, 409);
    assert.equal((await fetch(endpoint, { method: 'DELETE', headers })).status, 405);
    assert.equal(writes, 2);
  } finally { await hub.close(); }
});
