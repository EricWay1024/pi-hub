import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { historyPage, mergeMessages, messageKey } from '../shared/history.js';
import { savedHistoryPage } from '../server/history.js';

const message = (n: number) => ({ role: 'user', content: `Message ${n}`, timestamp: 1700000000000 + n });
test('history defaults to 40, pages without overlaps, and excludes hidden messages', () => {
  const messages = Array.from({ length: 125 }, (_, i) => message(i));
  messages.splice(20, 0, { role: 'system', content: 'Hidden', timestamp: 0 });
  const latest = historyPage(messages); assert.equal(latest.messages.length, 40); assert.equal(latest.messages[0].content, 'Message 85');
  const earlier = historyPage(messages, messageKey(latest.messages[0])); assert.equal(earlier.messages[0].content, 'Message 45');
  assert.equal(earlier.messages.at(-1)?.content, 'Message 84');
  const beginning = historyPage(messages, messageKey(message(5))); assert.equal(beginning.messages.length, 5); assert.equal(beginning.hasMore, false);
  assert.throws(() => historyPage(messages, 'unknown'), /cursor/);
  const merged = mergeMessages(earlier.messages, latest.messages, [message(124), message(125)]);
  assert.equal(merged.length, 81); assert.equal(merged.at(-1)?.content, 'Message 125');
  assert.equal(messageKey(message(1)), messageKey({ ...message(1), arbitraryMetadata: true }));
});
test('saved history reaches beyond the 300-message live buffer and follows cursor ancestors', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'pi-hub-history-')), file = path.join(tmp, 'session.jsonl');
  try {
    const entries: any[] = [{ type: 'session', version: 3, id: 'session', timestamp: new Date().toISOString(), cwd: tmp }];
    for (let i = 0; i < 900; i++) entries.push({ type: 'message', id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null, timestamp: new Date(1700000000000 + i).toISOString(), message: message(i) });
    // Last appended entry is on an abandoned branch. A cursor must pin the correct ancestry.
    entries.push({ type: 'message', id: 'other-branch', parentId: 'entry-10', timestamp: new Date().toISOString(), message: message(999) });
    await writeFile(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    const page = await savedHistoryPage(file, messageKey(message(350)));
    assert.equal(page.messages.length, 40); assert.equal(page.messages[0].content, 'Message 310');
    assert.equal(page.messages.at(-1)?.content, 'Message 349'); assert.equal(page.hasMore, true);
    assert.equal((await savedHistoryPage(file, messageKey(message(0)))).hasMore, false);
    await assert.rejects(savedHistoryPage(path.join(tmp, 'missing.jsonl')), /ENOENT/);
  } finally { await rm(tmp, { recursive: true }); }
});
