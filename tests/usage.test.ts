import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionUsage } from '../shared/usage.js';

test('session accounting includes all recorded model, tool, summary and compaction usage', () => {
  const usage = { input: 100, output: 10, cacheRead: 40, cacheWrite: 20, cost: { total: 0.125 } };
  const entries = [
    { type: 'message', message: { role: 'assistant', usage } },
    { type: 'message', message: { role: 'toolResult', usage } },
    { type: 'usage', usage }, { type: 'compaction', usage }, { type: 'branch_summary', usage },
    { type: 'message', message: { role: 'user', usage } },
    { type: 'custom', usage },
  ];
  assert.deepEqual(sessionUsage(entries), { tokens: { input: 500, output: 50, cacheRead: 200, cacheWrite: 100, total: 850 }, cost: 0.625 });
  assert.deepEqual(sessionUsage([]), { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
});
test('missing or invalid usage values do not contaminate totals', () => {
  assert.deepEqual(sessionUsage([{ type: 'message', message: { role: 'assistant' } }, { type: 'usage', usage: { input: NaN, output: -10, cacheRead: Infinity, cost: { total: NaN } } }]), sessionUsage([]));
});
