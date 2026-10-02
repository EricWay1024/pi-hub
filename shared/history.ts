import type { RecordData } from './state.js';
export const MESSAGE_PAGE_SIZE = 40;
export function visibleMessages(messages: RecordData[]): RecordData[] {
  return messages.filter(m => m.role !== 'system' && m.display !== false);
}
// Stable across RPC events and saved-session snapshots; no giant content in URL cursors.
export function messageKey(message: RecordData): string {
  const text = JSON.stringify([message.content, message.summary, message.command, message.output, message.errorMessage]);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `${message.role}:${message.timestamp ?? ''}:${message.toolCallId ?? ''}:${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}
export function mergeMessages(...pages: RecordData[][]): RecordData[] {
  const messages = new Map<string, RecordData>();
  for (const page of pages) for (const message of page) messages.set(messageKey(message), message);
  return [...messages.values()];
}
export function historyPage(messages: RecordData[], before?: string, limit = MESSAGE_PAGE_SIZE) {
  const visible = visibleMessages(messages);
  let end = visible.length;
  if (before) {
    end = visible.findLastIndex(m => messageKey(m) === before);
    if (end < 0) throw new Error('History cursor is no longer on this branch. Return to latest messages and try again.');
  }
  const start = Math.max(0, end - Math.min(100, Math.max(1, limit)));
  return { messages: visible.slice(start, end), hasMore: start > 0 };
}
