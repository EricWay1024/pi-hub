// Pi tool payloads are intentionally open-ended: third-party extensions own their schemas.
export type RecordData = Record<string, any>;
export interface AgentState {
  id: string; name: string; cwd: string; host: string; managed: boolean;
  online: boolean; busy: boolean; model?: string; thinking?: string;
  engine?: 'pi' | 'codex'; thinkingLevels?: string[];
  compaction?: { reason: 'manual' | 'threshold' | 'overflow'; startedAt: number };
  sessionFile?: string; sessionId?: string; totalMessageCount?: number; hasEarlierMessages?: boolean;
  messages: RecordData[]; partial?: RecordData;
  queue?: { steering: string[]; followUp: string[]; estimated?: boolean; tracked?: boolean };
  tools: Record<string, RecordData>; activity: RecordData[]; dialogs: Record<string, RecordData>;
  updatedAt: number;
}
export function emptyAgent(id: string): AgentState {
  return { id, name: 'Pi agent', cwd: '', host: '', managed: false, online: true, busy: false,
    messages: [], tools: {}, activity: [], dialogs: {}, updatedAt: Date.now() };
}
export function agentStatus(s: AgentState): string {
  if (!s.online) return 'Offline';
  if (s.compaction) return s.compaction.reason === 'manual' ? 'Compacting…' : 'Auto-compacting…';
  return s.busy ? 'Working' : 'Ready';
}
export function applyEvent(s: AgentState, e: RecordData): void {
  s.updatedAt = Date.now();
  if (['compaction_start', 'auto_compaction_start'].includes(e.type)) {
    s.compaction = { reason: ['manual', 'threshold', 'overflow'].includes(e.reason) ? e.reason : 'threshold', startedAt: Date.now() };
    s.busy = true;
  }
  if (['compaction_end', 'auto_compaction_end'].includes(e.type)) { s.compaction = undefined; if (e.reason === 'manual' && !e.willRetry) s.busy = false; }
  if (e.type === 'agent_start') s.busy = true;
  // agent_end is not idle: retries and queued continuations may still follow.
  if (e.type === 'agent_settled') { s.busy = false; s.compaction = undefined; if (s.queue) { s.queue.steering = []; s.queue.followUp = []; } }
  if (e.type === 'queue_update') s.queue = { steering: e.steering || [], followUp: e.followUp || [], estimated: !!e.estimated, tracked: true };
  if (e.type === 'session_info_changed') s.name = e.name || 'Pi agent';
  if (e.type === 'model_select' && e.model) s.model = e.model.id;
  if (e.type === 'thinking_level_changed') s.thinking = e.level;
  if (e.type === 'message_start' && e.message?.role === 'assistant') s.partial = structuredClone(e.message);
  if (e.type === 'message_update') {
    if (e.message) s.partial = structuredClone(e.message);
    else {
      const d = e.assistantMessageEvent;
      if (d && s.partial) {
        const blocks = s.partial.content ||= [];
        const i = d.contentIndex;
        if (d.type === 'text_delta' || d.type === 'thinking_delta') {
          const key = d.type === 'text_delta' ? 'text' : 'thinking';
          blocks[i] ||= { type: key, [key]: '' };
          blocks[i][key] += d.delta;
        }
        if (d.type === 'toolcall_end') blocks[i] = d.toolCall;
      }
    }
  }
  if (e.type === 'message_end' && e.message) {
    s.messages.push(e.message);
    if (e.message.role === 'user' && s.queue && !s.queue.tracked) {
      const text = typeof e.message.content === 'string' ? e.message.content : e.message.content?.filter((b: RecordData) => b.type === 'text').map((b: RecordData) => b.text).join('\n');
      for (const mode of ['steering', 'followUp'] as const) { const i = s.queue[mode].indexOf(text); if (i >= 0) { s.queue[mode].splice(i, 1); break; } }
    }
    s.totalMessageCount = (s.totalMessageCount ?? s.messages.length - 1) + 1;
    s.messages = s.messages.slice(-300);
    if (e.message.role === 'assistant') s.partial = undefined;
  }
  if (e.type.startsWith('tool_execution_')) {
    const prev = s.tools[e.toolCallId] || {};
    s.tools[e.toolCallId] = { ...prev, ...e, running: e.type !== 'tool_execution_end' };
    const keys = Object.keys(s.tools);
    if (keys.length > 100) delete s.tools[keys[0]];
  }
  if (e.type === 'extension_ui_request') {
    if (['select', 'confirm', 'input', 'editor'].includes(e.method)) s.dialogs[e.id] = e;
  }
  if (e.type.startsWith('subagents:') || e.type.startsWith('subagent:') || ['compaction_start', 'compaction_end', 'auto_compaction_start', 'auto_compaction_end', 'auto_retry_start', 'auto_retry_end', 'extension_error', 'diagnostic', 'queue_update', 'extension_ui_request'].includes(e.type)) {
    s.activity.push({ ...e, time: Date.now() }); s.activity = s.activity.slice(-100);
  }
}
