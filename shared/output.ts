import type { RecordData } from './state.js';
import { messageKey } from './history.js';
export function contentBlocks(message: RecordData): RecordData[] {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content.filter(Boolean) : [];
}
export function hasText(value: unknown): value is string { return typeof value === 'string' && !!value.replace(/[\s\u200b\ufeff]/g, ''); }
export function displayable(message: RecordData): boolean {
  if (message.role === 'system' || message.display === false) return false;
  if (message.role === 'toolResult' || message.role === 'bashExecution') return true;
  if (hasText(message.errorMessage) || hasText(message.summary)) return true;
  return contentBlocks(message).some(b => b.type === 'text' ? hasText(b.text) : b.type === 'thinking' ? hasText(b.thinking) : b.type === 'image' ? !!b.data : b.type === 'toolCall');
}
export interface ResponseGroup { key: string; actor: 'user' | 'agent'; messages: { key: string; message: RecordData }[] }
export function responseGroups(messages: RecordData[], partial?: RecordData): ResponseGroup[] {
  const groups: ResponseGroup[] = [];
  for (const [index, message] of [...messages, ...(partial ? [partial] : [])].entries()) {
    if (!displayable(message)) continue;
    const actor = message.role === 'user' ? 'user' : 'agent';
    const key = index === messages.length ? 'live-response' : messageKey(message);
    let group = groups.at(-1);
    if (actor === 'user' || !group || group.actor !== actor) { group = { key, actor, messages: [] }; groups.push(group); }
    group.messages.push({ key, message });
  }
  return groups;
}
export function toolName(name: string = '') { return name.split('.').at(-1) || 'tool'; }
export function humanLabel(key: string): string { return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_:.-]+/g, ' ').replace(/^./, c => c.toUpperCase()); }
export function cleanTerminal(text: string): string { return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''); }
export function parseOutput(text: string): unknown {
  const clean = cleanTerminal(text).trim();
  const candidate = clean.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  if (candidate.length <= 100_000 && /^[\[{]/.test(candidate)) { try { return JSON.parse(candidate); } catch {} }
  return cleanTerminal(text);
}
export function outputText(result?: RecordData): string { return contentBlocks(result || {}).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n'); }
export function toolPresentation(name: string, args: RecordData = {}) {
  const kind = toolName(name);
  const path = args.path || args.file_path || args.filePath || args.file || '';
  const command = typeof args.command === 'string' ? args.command : Array.isArray(args.command) ? args.command.join(' ') : '';
  const titles: Record<string, string> = { bash: 'Shell command', read: 'Read file', write: 'Write file', edit: 'Edit file', apply_patch: 'Apply patch', subagent: 'Subagent', subagents: 'Subagents', bg_wait: 'Background work', parallel: 'Parallel operations' };
  return { kind, title: titles[kind] || humanLabel(kind), path: typeof path === 'string' ? path : '', command, agent: typeof args.agent === 'string' ? args.agent : '', action: typeof args.action === 'string' ? args.action : '' };
}
export function toolStatus(result?: RecordData, execution?: RecordData): 'done' | 'running' | 'error' | 'pending' {
  if (result?.isError || execution?.isError || (typeof result?.details?.exitCode === 'number' && result.details.exitCode !== 0)) return 'error';
  if (result || execution?.type === 'tool_execution_end') return 'done';
  return execution?.running ? 'running' : 'pending';
}
export function activityPresentation(event: RecordData) {
  const data = event.payload && typeof event.payload === 'object' ? event.payload : event;
  const titles: Record<string, string> = { 'subagent:async-started': 'Subagent started', 'subagent:async-complete': 'Subagent finished', 'subagent:foreground-complete': 'Subagent finished', 'subagent:child-status': 'Subagent update', 'subagents:rpc:v1:ready': 'Subagents ready', compaction_start: 'Compacting context', compaction_end: 'Context compacted', auto_retry_start: 'Retrying request', auto_retry_end: 'Retry finished', queue_update: 'Message queue updated', diagnostic: 'Agent log', extension_error: 'Extension error', extension_ui_request: 'Agent notice' };
  const title = titles[event.type] || humanLabel(event.type || 'Agent update');
  const agent = typeof data.agent === 'string' ? data.agent : typeof data.label === 'string' ? data.label : '';
  const status = data.success === false || data.state === 'failed' || event.type === 'extension_error' ? 'error' : ['started', 'running', 'stopping'].includes(data.status || data.state) || event.type.endsWith('-started') ? 'running' : 'done';
  const summary = [data.summary, data.message, data.text, data.errorMessage, data.finalError, data.error, data.reason].find(hasText) || '';
  return { title, agent, status, summary, data };
}
