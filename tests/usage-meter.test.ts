import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyAgent } from '../shared/state.js';
import { ContextIndicator, UsageMeter } from '../web/UsageMeter.js';

test('usage meter shows context and compaction without a money estimate', () => {
  const agent = emptyAgent('context');
  const render = () => renderToStaticMarkup(createElement(UsageMeter, { agent, connected: true, request: async () => ({}) }));
  let html = render();
  assert.ok(html.includes('Context')); assert.ok(!html.includes('Session estimate')); assert.ok(!html.includes('USD')); assert.ok(!html.includes('cost'));
  agent.compaction = { reason: 'threshold', startedAt: 1 }; html = render();
  assert.ok(html.includes('auto-compacting…')); assert.ok(!html.includes('USD'));
  agent.compaction.reason = 'manual'; assert.ok(render().includes('compacting…'));
});
