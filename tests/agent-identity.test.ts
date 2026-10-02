import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { attachedAgentId, sameAttachedSession } from '../shared/agent-identity.js';
import { emptyAgent } from '../shared/state.js';
import { createConfig } from '../server/config.js';
import { createHub } from '../server/hub.js';

async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Identity update timed out');
}
test('attached identity survives factory reloads and matching never relies on a name or cwd', () => {
  assert.equal(attachedAgentId(), attachedAgentId());
  const a = { ...emptyAgent('a'), host: 'laptop', sessionId: 'session', name: 'Same name', cwd: '/same' };
  assert.equal(sameAttachedSession(a, { ...a, id: 'b' }), true);
  assert.equal(sameAttachedSession(a, { ...a, sessionId: 'other-session' }), false);
  assert.equal(sameAttachedSession(a, { ...a, host: 'other-host' }), false);
  assert.equal(sameAttachedSession(a, { ...a, managed: true }), false);
  assert.equal(sameAttachedSession({ ...a, sessionId: undefined }, { ...a, sessionId: undefined }), false);
  assert.equal(sameAttachedSession({ ...a, sessionId: undefined, sessionFile: '/session.jsonl' }, { ...a, sessionId: undefined, sessionFile: '/session.jsonl' }), true);
});
test('reload/restart duplicates are pruned, late socket close cannot mark the replacement offline, and distinct live agents remain', async () => {
  const config = createConfig('test-password-long', tmpdir()); config.port = 0;
  const hub = createHub(config); hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening');
  config.port = (hub.server.address() as any).port;
  const sockets: WebSocket[] = [];
  async function attach(id: string, sessionId: string, host = 'laptop') {
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/agent`, { headers: { Authorization: 'Bearer ' + config.agentToken } });
    sockets.push(ws); await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'register', id, metadata: { host, sessionId, name: 'Same name', cwd: '/same' } }));
    await until(() => hub.agents.get(id)?.online === true);
    return ws;
  }
  try {
    const old = await attach('old-runtime', 'session-one');
    const next = await attach('new-runtime', 'session-one');
    assert.equal(hub.agents.size, 2); // Two actually live processes are not merged.
    old.close(); await until(() => !hub.agents.has('old-runtime'));
    assert.equal(hub.agents.get('new-runtime')?.online, true);
    next.close(); await until(() => !hub.agents.get('new-runtime')?.online);
    const stable = await attach('stable-process', 'session-one');
    assert.equal(hub.agents.size, 1); assert.equal(hub.agents.has('new-runtime'), false);
    const retired = once(stable, 'close');
    await attach('stable-process', 'session-one'); // Same ID replaces the socket, not the agent.
    await retired; assert.equal(hub.agents.size, 1);
    assert.equal(hub.agents.get('stable-process')?.online, true);
    await attach('different-agent', 'different-session');
    const otherHost = await attach('other-host', 'session-one', 'another-laptop');
    otherHost.close(); await until(() => !hub.agents.get('other-host')?.online);
    await attach('third-runtime', 'session-one');
    assert.equal(hub.agents.get('different-agent')?.online, true);
    assert.equal(hub.agents.has('other-host'), true);
    assert.equal(hub.agents.get('stable-process')?.online, true); // Still a live independent socket.
  } finally { for (const ws of sockets) ws.terminate(); await hub.close(); }
});
