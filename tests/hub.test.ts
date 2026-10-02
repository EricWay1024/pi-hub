import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createConfig } from '../server/config.js';
import { allowedDirectory, createHub } from '../server/hub.js';

function next(ws: WebSocket, match: (record: any) => boolean) {
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', listener); reject(new Error('No matching record')); }, 3000);
    function listener(data: any) { const r = JSON.parse(data.toString()); if (match(r)) { clearTimeout(timeout); ws.off('message', listener); resolve(r); } }
    ws.on('message', listener);
  });
}
test('realpath confinement rejects siblings and symlink escapes', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'pi-hub-'));
  try {
    await mkdir(path.join(tmp, 'projects')); await mkdir(path.join(tmp, 'outside'));
    await symlink(path.join(tmp, 'outside'), path.join(tmp, 'projects', 'link'));
    await assert.rejects(allowedDirectory(path.join(tmp, 'projects'), path.join(tmp, 'outside')));
    await assert.rejects(allowedDirectory(path.join(tmp, 'projects'), path.join(tmp, 'projects', 'link')));
    assert.equal(await allowedDirectory(tmp, path.join(tmp, 'projects')), path.join(tmp, 'projects'));
  } finally { await rm(tmp, { recursive: true }); }
});
test('authentication, CSRF, agent routing, snapshots, reconnect and logout', async () => {
  const config = createConfig('test-password-long', tmpdir()); config.port = 0;
  const hub = createHub(config); hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening');
  const address = hub.server.address() as { port: number }; config.port = address.port;
  const origin = `http://127.0.0.1:${address.port}`;
  const wsUrl = origin.replace('http:', 'ws:');
  let browser: WebSocket | undefined, agent: WebSocket | undefined;
  try {
    assert.equal((await fetch(origin + '/api/projects')).status, 401);
    assert.equal((await fetch(origin + '/api/login', { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ password: 'wrong' }) })).status, 401);
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ password: 'test-password-long' }) });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(origin + '/api/projects', { headers: { Cookie: cookie } })).status, 200);
    const rejected = new WebSocket(wsUrl + '/ws', { headers: { Cookie: cookie, Origin: 'https://evil.example' } });
    rejected.on('error', () => {}); await new Promise<void>(resolve => rejected.on('close', () => resolve()));
    browser = new WebSocket(wsUrl + '/ws', { headers: { Cookie: cookie, Origin: origin } }); await once(browser, 'open');
    agent = new WebSocket(wsUrl + '/agent', { headers: { Authorization: 'Bearer ' + config.agentToken } }); await once(agent, 'open');
    const snapshot = next(browser, r => r.type === 'agent' && r.agent.id === 'test');
    agent.send(JSON.stringify({ type: 'register', id: 'test', metadata: { name: 'Test agent', cwd: '/tmp' } }));
    assert.equal((await snapshot).agent.name, 'Test agent');
    const busy = next(browser, r => r.type === 'agent' && r.agent.busy);
    agent.send(JSON.stringify({ type: 'event', event: { type: 'agent_start' } })); await busy;
    const queued = next(browser, r => r.type === 'agent' && r.agent.queue?.steering?.length);
    const command = next(agent, r => r.type === 'command');
    const reply = next(browser, r => r.type === 'reply' && r.id === 'browser-id');
    browser.send(JSON.stringify({ type: 'command', id: 'browser-id', agentId: 'test', command: { type: 'prompt', message: 'Hello' } }));
    const received = await command;
    assert.notEqual(received.command.id, 'browser-id');
    agent.send(JSON.stringify({ type: 'response', id: received.command.id, command: 'prompt', success: true }));
    assert.equal((await reply).success, true);
    assert.deepEqual((await queued).agent.queue.steering, ['Hello']);
    const event = next(browser, r => r.type === 'agent' && r.agent.messages?.length);
    agent.send(JSON.stringify({ type: 'event', event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello\u2028world' }] } } }));
    assert.equal((await event).agent.messages[0].content[0].text, 'hello\u2028world');
    const consumed = next(browser, r => r.type === 'agent' && r.agent.queue?.steering?.length === 0);
    agent.send(JSON.stringify({ type: 'event', event: { type: 'message_end', message: { role: 'user', content: 'Hello', timestamp: Date.now() } } })); await consumed;
    const offline = next(browser, r => r.type === 'agent' && !r.agent.online); agent.close(); await offline;
    const close = once(browser, 'close');
    assert.equal((await fetch(origin + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: '{}' })).status, 200); await close;
    assert.equal((await fetch(origin + '/api/projects', { headers: { Cookie: cookie } })).status, 401);
  } finally { browser?.terminate(); agent?.terminate(); await hub.close(); }
});
