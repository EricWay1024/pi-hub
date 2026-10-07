import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import hubExtension from '../extensions/hub.js';
import { createConfig } from '../server/config.js';

function next(ws: WebSocket, type: string) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Missing ' + type)), 3000);
    const listener = (data: any) => { const r = JSON.parse(data.toString()); if (r.type === type) { clearTimeout(timer); ws.off('message', listener); resolve(r); } };
    ws.on('message', listener);
  });
}
test('extension attaches, forwards images, discovers and dispatches registered slash commands, rejects unknown commands and cleans up', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pi-hub-extension-'));
  const server = http.createServer(); const wss = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = createConfig('test-password-long', temp); config.port = (server.address() as any).port;
  const old = process.env.PI_HUB_CONFIG, oldObserver = process.env.PI_HUB_OBSERVER_ID;
  delete process.env.PI_HUB_OBSERVER_ID; // Exercise terminal attachment even when tests run inside a Hub-managed Pi.
  process.env.PI_HUB_CONFIG = path.join(temp, 'config.json');
  await writeFile(process.env.PI_HUB_CONFIG, JSON.stringify(config));
  const handlers = new Map<string, Function>(), sent: any[] = [];
  const pi: any = { on: (type: string, handler: Function) => handlers.set(type, handler), events: { on: () => {} }, registerCommand: () => {}, getSessionName: () => 'Attached', getThinkingLevel: () => 'medium', getCommands: () => [{ name: 'example', description: 'Example command', source: 'extension' }, { name: 'disconnect-test', source: 'extension' }], sendUserMessage: (...args: any[]) => { sent.push(args); if (args[0][0].text === '/disconnect-test') handlers.get('session_shutdown')?.(); } };
  const ctx: any = { cwd: temp, model: { id: 'test-model' }, isIdle: () => false, getContextUsage: () => ({ tokens: 45000, contextWindow: 200000, percent: 22.5 }), sessionManager: { getBranch: () => [], getEntries: () => [{ type: 'usage', usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 0, cost: { total: 0.25 } } }], getSessionFile: () => undefined, getSessionId: () => 'session-test' }, ui: { setStatus: () => {} } };
  try {
    hubExtension(pi);
    const connection = once(wss, 'connection'); handlers.get('session_start')!({}, ctx);
    const [ws] = await connection as [WebSocket];
    const snapshot = await next(ws, 'snapshot'); assert.equal(snapshot.state.name, 'Attached');
    const response = next(ws, 'response');
    ws.send(JSON.stringify({ type: 'command', command: { type: 'prompt', id: 'prompt', message: 'Look', images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }], streamingBehavior: 'followUp' } }));
    assert.equal((await response).success, true);
    assert.equal(sent[0][0][1].type, 'image'); assert.equal(sent[0][1].deliverAs, 'followUp');
    assert.equal(sent[0][1].expandPromptTemplates, true);
    const discovered = next(ws, 'response'); ws.send(JSON.stringify({ type: 'command', command: { type: 'get_commands', id: 'commands' } }));
    assert.equal((await discovered).data.commands[0].name, 'example');
    const usage = next(ws, 'response'); ws.send(JSON.stringify({ type: 'command', command: { type: 'get_session_stats', id: 'usage' } }));
    const stats = (await usage).data; assert.equal(stats.cost, 0.25); assert.equal(stats.tokens.total, 130); assert.equal(stats.contextUsage.percent, 22.5);
    const compactStart = next(ws, 'event'); const compactSnapshot = next(ws, 'snapshot');
    handlers.get('session_before_compact')!({ reason: 'threshold' }, ctx);
    assert.equal((await compactStart).event.type, 'compaction_start'); assert.equal((await compactSnapshot).state.compaction.reason, 'threshold');
    const compactEnd = next(ws, 'event'); const compactCleared = next(ws, 'snapshot');
    handlers.get('session_compact')!({ reason: 'threshold', willRetry: false }, ctx);
    assert.equal((await compactEnd).event.type, 'compaction_end'); assert.equal((await compactCleared).state.compaction, null);
    const manualStart = next(ws, 'event'), manualSnapshot = next(ws, 'snapshot');
    handlers.get('session_before_compact')!({ reason: 'manual' }, ctx); await manualStart; await manualSnapshot;
    const compactFailed = next(ws, 'event'); const manualIdle = next(ws, 'snapshot');
    handlers.get('session_compact_failed')!({ reason: 'manual', aborted: true, willRetry: false }, ctx);
    assert.equal((await compactFailed).event.aborted, true); assert.equal((await manualIdle).state.busy, false);
    const dispatch = next(ws, 'response'); ws.send(JSON.stringify({ type: 'command', command: { type: 'prompt', id: 'example', message: '/example arguments' } }));
    assert.equal((await dispatch).success, true);
    assert.equal(sent[1][0][0].text, '/example arguments'); assert.equal(sent[1][1].expandPromptTemplates, true);
    const slash = next(ws, 'response'); ws.send(JSON.stringify({ type: 'command', command: { type: 'prompt', id: 'slash', message: '/test' } }));
    assert.equal((await slash).success, false);
    const queued = next(ws, 'event'); handlers.get('input')!({ text: 'Visible steering', streamingBehavior: 'steer' }, ctx);
    assert.deepEqual((await queued).event.steering, ['Visible steering']);
    const delivered = next(ws, 'event'); handlers.get('message_start')!({ type: 'message_start', message: { role: 'user', content: 'Visible steering' } }, ctx);
    assert.deepEqual((await delivered).event.steering, []);
    const settled = next(ws, 'snapshot'); handlers.get('agent_settled')!({ type: 'agent_settled' }, ctx);
    assert.equal((await settled).state.busy, false);
    const disconnected = next(ws, 'response');
    ws.send(JSON.stringify({ type: 'command', command: { type: 'prompt', id: 'disconnect', message: '/disconnect-test' } }));
    assert.equal((await disconnected).success, true); // ACK must survive a command closing its connection.
  } finally {
    handlers.get('session_shutdown')?.(); for (const ws of wss.clients) ws.terminate();
    wss.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (old === undefined) delete process.env.PI_HUB_CONFIG; else process.env.PI_HUB_CONFIG = old;
    if (oldObserver === undefined) delete process.env.PI_HUB_OBSERVER_ID; else process.env.PI_HUB_OBSERVER_ID = oldObserver;
    await rm(temp, { recursive: true });
  }
});
