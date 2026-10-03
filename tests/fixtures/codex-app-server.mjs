#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
let threadId = 'thread-test';
const saved = { id: 'thread-saved', name: 'Saved Codex', preview: 'Earlier Codex conversation', cwd: process.env.PI_HUB_CODEX_TEST_CWD || process.cwd(), createdAt: 1700000000, updatedAt: 1700000100, status: { type: process.env.PI_HUB_CODEX_TEST_STATUS || 'notLoaded' }, model: 'test-model', reasoningEffort: 'high', historyMode: process.env.PI_HUB_CODEX_TEST_LEGACY ? 'legacy' : 'paginated' };
const items = Array.from({ length: 90 }, (_, i) => ({ turnId: 'turn-' + Math.floor(i / 3), item: { type: 'agentMessage', id: 'item-' + i, text: 'Saved message ' + i } }));
const send = r => process.stdout.write(JSON.stringify(r) + '\n');
const event = (method, params) => send({ method, params: { threadId, ...params } });
let counter = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line); if (process.env.PI_HUB_CODEX_TEST_LOG) appendFileSync(process.env.PI_HUB_CODEX_TEST_LOG, JSON.stringify(r) + '\n');
  if (!r.method) return;
  const p = r.params || {}, reply = result => send({ id: r.id, result });
  switch (r.method) {
    case 'initialize': reply({ userAgent: 'fake-codex' }); break;
    case 'initialized': break;
    case 'thread/list': reply({ data: [saved, { ...saved, id: 'outside', cwd: '/' }].filter(t => !p.cwd || t.cwd === p.cwd), nextCursor: null }); break;
    case 'thread/read': reply({ thread: { ...saved, turns: p.includeTurns ? [{ id: 'legacy-turn', items: items.map(e => e.item) }] : [] } }); break;
    case 'thread/resume': threadId = p.threadId; reply({ thread: { ...saved, id: threadId, turns: [] }, model: 'test-model', reasoningEffort: 'high' }); break;
    case 'thread/start': reply({ thread: { id: threadId, reasoningEffort: 'medium' }, model: 'test-model', reasoningEffort: 'medium' }); break;
    case 'thread/name/set': reply({}); event('thread/name/updated', { threadName: p.name }); break;
    case 'model/list': reply({ data: [{ id: 'test-model', model: 'test-model', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }], nextCursor: null }); break;
    case 'thread/items/list': { const end = p.cursor ? Number(p.cursor) : items.length, start = Math.max(0, end - p.limit); reply({ data: items.slice(start, end).reverse(), nextCursor: start ? String(start) : null }); break; }
    case 'turn/start': {
      const id = 'turn-live-' + ++counter; event('turn/started', { turn: { id } });
      event('item/started', { item: { type: 'userMessage', id: 'user-' + counter, content: p.input } });
      if (p.input[0].text === 'hang') break;
      if (p.input[0].text === 'block') {
        send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: id, itemId: 'shell-live', command: 'echo test', reason: 'Test approval', availableDecisions: ['accept', 'decline', 'cancel'] } });
      } else {
        event('item/started', { item: { type: 'agentMessage', id: 'agent-' + counter, text: '' } });
        event('item/agentMessage/delta', { itemId: 'agent-' + counter, delta: 'Streamed response' });
        event('item/completed', { item: { type: 'agentMessage', id: 'agent-' + counter, text: 'Streamed response' } });
        event('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 45000 }, total: { totalTokens: 100000 }, modelContextWindow: 200000 } });
        event('turn/completed', { turn: { id, status: 'completed' } });
      }
      // Deliberately stale ACK after completion to catch busy-state races.
      reply({ turn: { id, status: 'inProgress' } }); break;
    }
    case 'turn/steer': if (p.expectedTurnId !== 'turn-live-' + counter) send({ id: r.id, error: { message: 'Wrong turn precondition' } }); else reply({}); break;
    case 'turn/interrupt': event('turn/completed', { turn: { id: p.turnId, status: 'interrupted' } }); reply({}); break;
    case 'thread/compact/start': event('item/started', { item: { type: 'contextCompaction', id: 'compact' } }); event('item/completed', { item: { type: 'contextCompaction', id: 'compact' } }); event('thread/compacted', {}); reply({}); break;
    default: send({ id: r.id, error: { message: 'Unsupported fake method ' + r.method } });
  }
});
