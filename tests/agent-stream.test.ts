import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createConfig } from '../server/config.js';
import { createHub } from '../server/hub.js';
import { emptyAgent } from '../shared/state.js';
import { AgentStreamEncoder, AgentStreamDecoder } from '../shared/agent-stream.js';
import { attachBrowserStream } from '../server/browser-stream.js';

const clone = <T>(value: T): NonNullable<T> => { assert.notEqual(value, undefined); return JSON.parse(JSON.stringify(value)); };
const agent = () => ({ id: 'a', name: 'Test', messages: [{ role: 'user', content: 'Hi' }],
  tools: { image: { result: { content: [{ type: 'image', mimeType: 'image/png', data: 'x'.repeat(4_000_000) }] } } },
  partial: { content: [{ type: 'text', text: '' }] }, busy: true });

test('delta snapshots preserve complete data, deletions, session switches and unchanged references', () => {
  const encoder = new AgentStreamEncoder(), decoder = new AgentStreamDecoder();
  const state: any = agent();
  const initial = decoder.decode(clone(encoder.encode({ type: 'agent', agent: state })));
  state.partial.content[0].text = 'Hello';
  const wire = encoder.encode({ type: 'agent', agent: state })!;
  assert.equal(wire.type, 'agent_patch');
  assert.ok(JSON.stringify(wire).length < 300);
  const next = decoder.decode(clone(wire));
  assert.deepEqual(next.agent, state);
  assert.equal(next.agent.messages, initial.agent.messages);
  assert.equal(next.agent.tools, initial.agent.tools);
  delete state.partial; delete state.tools.image; state.busy = false;
  state.messages.push({ role: 'assistant', content: 'Hello' });
  assert.deepEqual(decoder.decode(clone(encoder.encode({ type: 'agent', agent: state }))).agent, state);
  state.sessionId = 'new'; state.messages = []; state.tools = {};
  assert.deepEqual(decoder.decode(clone(encoder.encode({ type: 'agent', agent: state }))).agent, state);
  assert.equal(encoder.encode({ type: 'agent', agent: state }), undefined);
  assert.equal(new AgentStreamEncoder().encode({ type: 'agent', agent: state })!.type, 'agent');
});

test('large historical tool images are not resent with every streaming token or new tool', () => {
  const encoder = new AgentStreamEncoder(), decoder = new AgentStreamDecoder();
  const state: any = agent();
  decoder.decode(clone(encoder.encode({ type: 'agent', agent: state })));
  let bytes = 0;
  for (let i = 0; i < 100; i++) {
    state.partial.content[0].text += 'x';
    const wire = encoder.encode({ type: 'agent', agent: state })!;
    bytes += Buffer.byteLength(JSON.stringify(wire));
    assert.deepEqual(decoder.decode(clone(wire)).agent, state);
  }
  assert.ok(bytes < 30_000, `${bytes} incremental bytes, not 400 MB of repeated images`);
  state.tools.small = { result: { content: [{ type: 'text', text: 'ok' }] } };
  const toolUpdate = encoder.encode({ type: 'agent', agent: state })!;
  assert.ok(JSON.stringify(toolUpdate).length < 300);
  assert.deepEqual(decoder.decode(clone(toolUpdate)).agent, state);
});

test('removed/reintroduced agents get a new full baseline', () => {
  const encoder = new AgentStreamEncoder(), decoder = new AgentStreamDecoder();
  const record = { type: 'agent', agent: agent() };
  decoder.decode(clone(encoder.encode(record)));
  decoder.decode(encoder.encode({ type: 'agents', agents: [] })!);
  assert.equal(encoder.encode(record)!.type, 'agent');
  assert.throws(() => decoder.decode({ type: 'agent_patch', agentId: 'a', set: {}, unset: [], tools: { put: {}, remove: [] } }), /before its snapshot/);
});

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0;
  sent: any[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('slow sockets coalesce snapshots but never coalesce replies; latest state remains reconstructible', async t => {
  const ws = new Socket(), decoder = new AgentStreamDecoder();
  attachBrowserStream(ws as unknown as WebSocket, true); t.after(() => ws.close());
  const state: any = agent(); state.tools = {};
  ws.bufferedAmount = 100_000;
  for (let i = 0; i < 10; i++) { state.partial.content[0].text = String(i); ws.send(JSON.stringify({ type: 'agent', agent: state })); }
  ws.send(JSON.stringify({ type: 'reply', id: 'command', success: true }));
  await delay(80);
  assert.equal(ws.sent.length, 1); assert.equal(ws.sent[0].type, 'reply');
  ws.bufferedAmount = 0; await delay(80);
  assert.equal(ws.sent.length, 2);
  assert.deepEqual(decoder.decode(ws.sent[1]).agent, state);
  for (let i = 10; i < 20; i++) { state.partial.content[0].text = String(i); ws.send(JSON.stringify({ type: 'agent', agent: state })); }
  await delay(350);
  assert.equal(ws.sent.length, 3); assert.equal(ws.sent[2].type, 'agent_patch');
  assert.deepEqual(decoder.decode(ws.sent[2]).agent, state);
});

test('real WebSocket: a slow browser with 20 MB history survives streaming without resending it', { timeout: 15_000 }, async t => {
  const config = createConfig('stream-test-password', tmpdir()); config.port = 0;
  const hub = createHub(config); hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening');
  t.after(() => hub.close());
  config.port = (hub.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${config.port}`, url = origin.replace('http:', 'ws:');
  const state = emptyAgent('large');
  state.tools = { image: { result: { content: [{ type: 'image', mimeType: 'image/png', data: 'x'.repeat(20_000_000) }] } } };
  hub.agents.set(state.id, state);
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ password: 'stream-test-password' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const decoder = new AgentStreamDecoder(); let initial = false, incrementalBytes = 0, latest: any;
  const browser = new WebSocket(url + '/ws?updates=delta-v1', { headers: { Cookie: cookie, Origin: origin } });
  t.after(() => browser.terminate());
  browser.on('message', data => {
    if (initial) incrementalBytes += Buffer.byteLength(data.toString());
    const record = decoder.decode(JSON.parse(data.toString()));
    if (record.type === 'agent') { initial = true; latest = record.agent; }
  });
  await once(browser, 'open'); browser.pause();
  const source = new WebSocket(url + '/agent', { headers: { Authorization: 'Bearer ' + config.agentToken } });
  t.after(() => source.terminate()); await once(source, 'open');
  source.send(JSON.stringify({ type: 'register', id: state.id, metadata: {} }));
  for (let i = 0; i < 10; i++) {
    source.send(JSON.stringify({ type: 'event', event: { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: `token ${i}` }] } } }));
    await delay(50);
  }
  assert.equal(browser.readyState, WebSocket.OPEN, 'Slow reader must not be evicted by repeated full snapshots');
  browser.resume();
  for (let i = 0; i < 100 && latest?.partial?.content[0]?.text !== 'token 9'; i++) await delay(50);
  assert.equal(latest?.partial?.content[0]?.text, 'token 9');
  assert.equal(latest.tools.image.result.content[0].data.length, 20_000_000);
  assert.ok(incrementalBytes < 50_000, `Repeated history consumed ${incrementalBytes} bytes`);
  assert.equal(browser.readyState, WebSocket.OPEN);
});

test('legacy clients retain full snapshots; closed sockets discard queued work', async () => {
  const ws = new Socket(); attachBrowserStream(ws as unknown as WebSocket, false);
  ws.send(JSON.stringify({ type: 'agent', agent: { id: 'a', messages: [], tools: {} } }));
  await delay(60); assert.equal(ws.sent[0].type, 'agent');
  ws.send(JSON.stringify({ type: 'agent', agent: { id: 'a', messages: [], tools: {}, busy: true } }));
  ws.close(); await delay(60); assert.equal(ws.sent.length, 1);
});
