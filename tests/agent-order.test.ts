import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveAgent, orderedIds } from '../shared/agent-order.js';
test('agent order preserves saved live IDs, deduplicates and appends newly discovered agents', () => {
  assert.deepEqual(orderedIds(['b', 'missing', 'b', 'a'], ['a', 'b', 'c']), ['b', 'a', 'c']);
  assert.deepEqual(orderedIds(['b', 'a'], []), []);
});
test('agents move before/after any target or to the end without changing identity', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(moveAgent(ids, 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveAgent(ids, 'a', 'c', true), ['b', 'c', 'a']);
  assert.deepEqual(moveAgent(ids, 'a'), ['b', 'c', 'a']);
  assert.deepEqual(moveAgent(ids, 'b', 'b'), ids);
  assert.deepEqual(moveAgent(ids, 'missing', 'a'), ids);
  assert.deepEqual(ids, ['a', 'b', 'c']);
});
