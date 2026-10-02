import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Transcript } from '../web/Transcript.js';
import { ToolCard } from '../web/ToolOutput.js';
import { MessageQueue } from '../web/MessageQueue.js';
import { activityPresentation, displayable, parseOutput, responseGroups } from '../shared/output.js';
import { applyEvent, emptyAgent } from '../shared/state.js';

test('tool rounds share one identity label; call and result are paired; empty reasoning is invisible', () => {
  const messages = [
    { role: 'user', content: 'Please check this', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'thinking', thinking: ' \n\u200b', thinkingSignature: 'secret' }], timestamp: 2 },
    { role: 'assistant', content: [{ type: 'text', text: 'Checking the file.' }, { type: 'toolCall', id: 'read-one', name: 'read', arguments: { path: 'proof.tex' } }], timestamp: 3 },
    { role: 'toolResult', toolCallId: 'read-one', toolName: 'read', content: [{ type: 'text', text: 'Proof content' }], timestamp: 4 },
    { role: 'assistant', content: [{ type: 'text', text: 'The result is $x^2$.' }], timestamp: 5 },
  ];
  const html = renderToStaticMarkup(createElement(Transcript, { messages }));
  assert.equal(responseGroups(messages).length, 2);
  assert.equal((html.match(/turn-label">Pi/g) || []).length, 1);
  assert.equal((html.match(/class="tool-card /g) || []).length, 1);
  assert.equal((html.match(/Proof content/g) || []).length, 1);
  assert.ok(!html.includes('Reasoning')); assert.ok(!html.includes('secret')); assert.ok(!html.includes('π · Pi'));
  assert.ok(html.includes('Read file')); assert.ok(html.includes('proof.tex')); assert.ok(html.includes('katex'));
  assert.equal(displayable(messages[1]), false);
});
test('structured outputs are readable fields rather than raw JSON and edits show highlighted diffs', () => {
  const html = renderToStaticMarkup(createElement(ToolCard, { name: 'subagent', args: { agent: 'reviewer' }, result: { content: [{ type: 'text', text: '{"agent":"reviewer","status":"complete","summary":"**Proof checked**","exitCode":0}' }] } }));
  assert.ok(html.includes('subagent-report')); assert.ok(html.includes('Proof checked')); assert.ok(html.includes('Exit Code') || html.includes('Exit code'));
  assert.ok(!html.includes('&quot;agent&quot;'));
  const diff = renderToStaticMarkup(createElement(ToolCard, { name: 'edit', args: { path: 'proof.tex' }, result: { content: [{ type: 'text', text: 'Updated file' }], details: { patch: '-old\n+new' } } }));
  assert.ok(diff.includes('diff-add')); assert.ok(diff.includes('diff-remove'));
  assert.deepEqual(parseOutput('\x1b[32m{"ok":true}\x1b[0m'), { ok: true });
  assert.equal(activityPresentation({ type: 'subagent:async-complete', payload: { agent: 'reviewer', state: 'failed', success: false } }).status, 'error');
});
test('steering and follow-up queues are visible, authoritative duplicate messages are not removed twice', () => {
  const state = emptyAgent('queue');
  applyEvent(state, { type: 'queue_update', steering: ['Do this next'], followUp: ['Then summarize'] });
  const html = renderToStaticMarkup(createElement(MessageQueue, { queue: state.queue }));
  assert.ok(html.includes('Steering')); assert.ok(html.includes('Do this next')); assert.ok(html.includes('Follow-up')); assert.ok(html.includes('Then summarize'));
  applyEvent(state, { type: 'message_end', message: { role: 'user', content: 'Do this next' } });
  assert.equal(state.queue?.steering.length, 1); // Native queue_update controls delivery.
  state.queue = { steering: ['same', 'same'], followUp: [], tracked: false };
  applyEvent(state, { type: 'message_end', message: { role: 'user', content: 'same' } });
  assert.equal(state.queue.steering.length, 1);
  applyEvent(state, { type: 'agent_settled' }); assert.equal(state.queue.steering.length, 0);
});
