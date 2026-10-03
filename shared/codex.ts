import type { RecordData } from './state.js';

/** Stable item IDs are used as timestamps so live and paginated history deduplicate. */
export function codexMessages(item: RecordData): RecordData[] {
  const base = { timestamp: `codex:${item.id}`, codexItemId: item.id };
  if (item.type === 'userMessage') return [{ ...base, role: 'user', content: (item.content || []).flatMap((c: RecordData) => c.type === 'text' ? [{ type: 'text', text: c.text }] : c.type === 'image' && typeof c.url === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(c.url) ? [{ type: 'image', mimeType: c.url.slice(5, c.url.indexOf(';')), data: c.url.slice(c.url.indexOf(',') + 1) }] : []) }];
  if (item.type === 'agentMessage' || item.type === 'plan') return [{ ...base, role: 'assistant', content: [{ type: 'text', text: item.text || '' }] }];
  if (item.type === 'reasoning') return [{ ...base, role: 'assistant', content: [{ type: 'thinking', thinking: (item.summary?.length ? item.summary : item.content || []).join('\n\n') }] }];
  let name: string, args: RecordData, text: string, details: RecordData = {};
  if (item.type === 'commandExecution') { name = 'bash'; args = { command: item.command }; text = item.aggregatedOutput || ''; if (typeof item.exitCode === 'number') details.exitCode = item.exitCode; }
  else if (item.type === 'fileChange') { name = 'apply_patch'; args = { path: (item.changes || []).map((c: RecordData) => c.path).join(', ') }; text = 'File changes'; details.patch = (item.changes || []).map((c: RecordData) => `--- ${c.path}\n${c.diff}`).join('\n'); }
  else if (item.type === 'mcpToolCall') { name = `${item.server}/${item.tool}`; args = item.arguments || {}; text = JSON.stringify(item.error || item.result || {}); }
  else if (item.type === 'dynamicToolCall') { name = item.tool; args = item.arguments || {}; text = JSON.stringify(item.contentItems || []); }
  else if (item.type === 'collabAgentToolCall') { name = 'subagent'; args = { agent: item.receiverThreadIds?.join(', '), action: item.tool }; text = JSON.stringify({ status: item.status, agents: item.agentsStates }); }
  else return [];
  const call = { ...base, role: 'assistant', content: [{ type: 'toolCall', id: item.id, name, arguments: args }] };
  if (['inProgress', 'running'].includes(item.status)) return [call];
  return [call, { ...base, role: 'toolResult', toolCallId: item.id, toolName: name, content: [{ type: 'text', text }], details, isError: ['failed', 'declined'].includes(item.status) || typeof item.exitCode === 'number' && item.exitCode !== 0 }];
}
