import { stat } from 'node:fs/promises';
import { historyPage, messageKey, MESSAGE_PAGE_SIZE } from '../shared/history.js';
import type { RecordData } from '../shared/state.js';

function entryMessage(entry: RecordData): RecordData | undefined {
  if (entry.type === 'message') return entry.message;
  if (entry.type === 'custom_message') return { role: 'custom', content: entry.content, display: entry.display, customType: entry.customType, timestamp: Date.parse(entry.timestamp) };
}
/** Read history without a model call. Follow cursor ancestors, never abandoned branches. */
export async function savedHistoryPage(file: string, before?: string, limit = MESSAGE_PAGE_SIZE) {
  await stat(file); // SessionManager.open would create a missing session; reads must never do that.
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const manager = SessionManager.open(file);
  let fromId: string | undefined;
  if (before) {
    const entry = manager.getEntries().findLast(entry => {
      const message = entryMessage(entry);
      return message && messageKey(message) === before;
    });
    if (!entry) throw new Error('History cursor is not saved yet or the conversation changed. Return to latest messages and try again.');
    fromId = entry.id;
  }
  const messages = manager.getBranch(fromId).map(entry => entryMessage(entry)).filter((m): m is RecordData => !!m);
  return historyPage(messages, before, limit);
}
