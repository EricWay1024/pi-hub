import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandList, filterCommands, parseSlashCommand, slashQuery } from '../shared/commands.js';

test('slash completion opens only for a command token at the cursor', () => {
  assert.equal(slashQuery('/'), ''); assert.equal(slashQuery('/Mo'), 'mo');
  assert.equal(slashQuery('/skill:algebra'), 'skill:algebra');
  for (const text of ['hello /model', '/model args', '/model\n', 'https://pi.dev', '']) assert.equal(slashQuery(text), null);
  assert.equal(slashQuery('/model', 2), null);
  assert.deepEqual(parseSlashCommand('/name A long name'), { name: 'name', args: 'A long name' });
  assert.deepEqual(parseSlashCommand('/compact\nKeep the proof'), { name: 'compact', args: 'Keep the proof' });
  assert.equal(parseSlashCommand('/'), null);
});
test('commands combine live extensions, templates and skills with explicit CLI-only entries', () => {
  const commands = commandList([
    { name: 'review', description: 'Review code', source: 'extension' },
    { name: 'skill:algebra', description: 'Homological algebra', source: 'skill' },
    { name: 'proof', description: 'Check a proof', source: 'prompt' },
    { name: 'review', description: 'Duplicate', source: 'extension' },
    { name: 'model', description: 'Must not replace web control', source: 'extension' },
    { name: 'bad command', source: 'extension' }, { name: '/bad', source: 'skill' },
  ]);
  assert.equal(commands.filter(c => c.name === 'review').length, 1);
  assert.equal(commands.find(c => c.name === 'model')?.source, 'web');
  assert.equal(commands.find(c => c.name === 'reload')?.unavailable, true);
  assert.equal(commands.find(c => c.name === 'skill:algebra')?.source, 'skill');
  assert.equal(filterCommands(commands, 'rev')[0].name, 'review');
  assert.equal(filterCommands(commands, 'homological')[0].name, 'skill:algebra');
  assert.equal(filterCommands(commands, 'model')[0].name, 'model');
  assert.deepEqual(filterCommands(commands, 'nonexistent'), []);
});
