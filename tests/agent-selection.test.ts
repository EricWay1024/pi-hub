import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableSelection, loadSelectedAgent, rememberSelectedAgent } from '../web/agentSelection.js';

function browserStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const agents = [{ id: 'first' }, { id: 'last-used' }];

test('page reload restores the last selected agent rather than the first inventory item', () => {
  const storage = browserStorage();
  assert.equal(loadSelectedAgent(storage), '');
  rememberSelectedAgent('last-used', storage);
  assert.equal(availableSelection(loadSelectedAgent(storage), agents), 'last-used');
  assert.equal(availableSelection('last-used', [...agents].reverse()), 'last-used');
});

test('missing agents fall back safely and the new choice is remembered', () => {
  const storage = browserStorage();
  rememberSelectedAgent('removed', storage);
  const selected = availableSelection(loadSelectedAgent(storage), agents);
  assert.equal(selected, 'first');
  rememberSelectedAgent(selected, storage);
  assert.equal(loadSelectedAgent(storage), 'first');
  assert.equal(availableSelection('', agents), 'first');
});

test('empty inventories do not erase the remembered selection', () => {
  const storage = browserStorage();
  rememberSelectedAgent('last-used', storage);
  const emptySelection = availableSelection(loadSelectedAgent(storage), []);
  assert.equal(emptySelection, '');
  rememberSelectedAgent(emptySelection, storage);
  assert.equal(loadSelectedAgent(storage), 'last-used');
  assert.equal(availableSelection(emptySelection || loadSelectedAgent(storage), agents), 'last-used');
});

test('agent identity replacements remain selected, but missing replacements are not used', () => {
  assert.equal(availableSelection('old-id', agents, { 'old-id': 'last-used' }), 'last-used');
  assert.equal(availableSelection('old-id', agents, { 'old-id': 'missing' }), 'first');
  assert.equal(availableSelection('last-used', agents, { 'last-used': 'first' }), 'last-used');
});

test('storage denial does not prevent agent selection', () => {
  const storage = { getItem(): string | null { throw new Error('Storage disabled'); }, setItem() { throw new Error('Storage disabled'); } };
  assert.equal(loadSelectedAgent(storage), '');
  assert.doesNotThrow(() => rememberSelectedAgent('last-used', storage));
  assert.equal(availableSelection('last-used', agents), 'last-used');
});
