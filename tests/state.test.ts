import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentStatus, applyEvent, emptyAgent } from '../shared/state.js';
import { checkPassword, createConfig } from '../server/config.js';

test('password hashes are salted and validate without storing plaintext', () => {
  const c = createConfig('test-password-long', '/tmp');
  assert.equal(checkPassword('test-password-long', c), true);
  assert.equal(checkPassword('bad-password', c), false);
  assert.notEqual(c.passwordHash, createConfig('test-password-long', '/tmp').passwordHash);
});
test('compaction status covers automatic/manual runs and clears on finish, abort, failure and settle', () => {
  const s = emptyAgent('compact'); s.queue = { steering: ['Keep this'], followUp: [], tracked: true };
  for (const reason of ['threshold', 'overflow', 'manual']) {
    applyEvent(s, { type: 'compaction_start', reason });
    assert.equal(agentStatus(s), reason === 'manual' ? 'Compacting…' : 'Auto-compacting…');
    assert.equal(s.busy, true); assert.deepEqual(s.queue.steering, ['Keep this']);
    applyEvent(s, { type: 'agent_end' }); assert.ok(s.compaction);
    applyEvent(s, { type: 'compaction_end', reason, aborted: false, willRetry: reason !== 'manual' });
    assert.equal(s.compaction, undefined); assert.equal(s.busy, reason !== 'manual');
  }
  for (const end of [{ aborted: true }, { errorMessage: 'Failed' }]) {
    applyEvent(s, { type: 'compaction_start', reason: 'threshold' });
    applyEvent(s, { type: 'compaction_end', ...end }); assert.equal(s.compaction, undefined);
  }
  applyEvent(s, { type: 'auto_compaction_start', reason: 'overflow' }); assert.equal(agentStatus(s), 'Auto-compacting…');
  s.online = false; assert.equal(agentStatus(s), 'Offline'); s.online = true;
  applyEvent(s, { type: 'auto_compaction_end' }); assert.equal(s.compaction, undefined);
  applyEvent(s, { type: 'compaction_start', reason: 'threshold' }); applyEvent(s, { type: 'agent_settled' });
  assert.equal(agentStatus(s), 'Ready'); assert.equal(s.compaction, undefined);
});

test('streaming, tools and retries are reconstructed; only settled means idle', () => {
  const s = emptyAgent('one');
  applyEvent(s, { type: 'agent_start' });
  applyEvent(s, { type: 'message_start', message: { role: 'assistant', content: [] } });
  for (const delta of ['Hello ', 'world']) applyEvent(s, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } });
  assert.equal(s.partial?.content[0].text, 'Hello world');
  applyEvent(s, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Authoritative' }] } });
  assert.equal(s.partial, undefined); assert.equal(s.messages[0].content[0].text, 'Authoritative');
  applyEvent(s, { type: 'tool_execution_start', toolCallId: 'tool', toolName: 'bash', args: { command: 'ls' } });
  applyEvent(s, { type: 'tool_execution_end', toolCallId: 'tool', result: { content: [] } });
  assert.equal(s.tools.tool.running, false); assert.equal(s.tools.tool.args.command, 'ls');
  applyEvent(s, { type: 'agent_end', willRetry: true }); assert.equal(s.busy, true);
  applyEvent(s, { type: 'agent_settled' }); assert.equal(s.busy, false);
  applyEvent(s, { type: 'subagent:child-status', payload: { id: 'child' } }); assert.equal(s.activity.length, 1);
});
