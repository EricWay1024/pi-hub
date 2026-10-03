import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentState, RecordData } from '../shared/state.js';
import { codexMessages } from '../shared/codex.js';
import { messageKey, MESSAGE_PAGE_SIZE } from '../shared/history.js';

/** One private stdio app-server per Hub-owned agent. Never touches the shared daemon. */
export class CodexAgent {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (v: RecordData) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private approvals = new Map<string, { id: string | number; method: string; params: RecordData }>();
  private items = new Map<string, RecordData>();
  private models: RecordData[] = [];
  private turnId?: string;
  private stats: RecordData = {};
  private closed = false;
  private manualCompact = false;
  private commandInFlight = false;
  private lifecycleRevision = 0;
  get active() { return !this.closed; }
  constructor(private state: AgentState, private changed: () => void) {
    this.child = spawn(process.env.PI_HUB_CODEX_BIN || 'codex', ['app-server', '--stdio'], { cwd: state.cwd, env: { ...process.env, PI_HUB_OBSERVER_ID: undefined }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) { this.stop(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { this.receive(JSON.parse(line)); } catch { this.fail('Invalid Codex protocol record'); this.stop(); }
      }
    });
    // Drain logs, but never broadcast configuration/authentication diagnostics to browsers.
    this.child.stderr.resume();
    this.child.on('error', () => this.fail('Cannot start Codex. Install the Codex CLI or set PI_HUB_CODEX_BIN.'));
    this.child.on('exit', () => this.fail('Codex app-server exited. Its saved thread remains on disk.'));
  }
  private write(value: unknown) {
    if (this.closed) throw new Error('Codex is offline');
    this.child.stdin.write(JSON.stringify(value) + '\n', error => { if (error) this.fail('Codex transport failed'); });
  }
  private rpc(method: string, params: RecordData): Promise<RecordData> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex confirmation timed out; the command may have been accepted. Check history before resending.')); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  private fail(message: string) {
    this.closed = true; this.state.online = false; this.state.busy = false; this.state.compaction = undefined; this.state.dialogs = {}; this.approvals.clear();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); } this.pending.clear(); this.touch();
  }
  stop() {
    this.fail('Codex stopped. Check history before resending unconfirmed commands.');
    this.child.kill('SIGTERM'); const timer = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL'); }, 5000); timer.unref();
  }
  private touch() { this.state.updatedAt = Date.now(); this.changed(); }
  async start() {
    await this.rpc('initialize', { clientInfo: { name: 'pi_hub', title: 'Pi Hub', version: '0.1.0' }, capabilities: null });
    this.write({ method: 'initialized' });
    // No policy overrides: preserve Codex's configured sandbox, approvals, hooks and login.
    const result = await this.rpc('thread/start', { cwd: this.state.cwd });
    this.state.sessionId = result.thread.id; this.state.model = result.model; this.state.thinking = result.reasoningEffort || result.thread.reasoningEffort || 'medium';
    await this.rpc('thread/name/set', { threadId: this.state.sessionId, name: this.state.name });
    const models = await this.catalog();
    const model = models.find(m => (m.model || m.id) === this.state.model);
    this.state.thinkingLevels = (model?.supportedReasoningEfforts || []).map((e: RecordData) => e.reasoningEffort);
    this.state.online = true; this.touch();
  }
  private updateItem(item: RecordData) {
    if (!item?.id || typeof item.id !== 'string') return;
    this.items.set(item.id, item);
    const converted = codexMessages(item), call = converted[0]?.content?.find((b: RecordData) => b.type === 'toolCall');
    if (call) {
      this.state.tools[item.id] = { toolCallId: item.id, toolName: call.name, args: call.arguments, running: ['inProgress', 'running'].includes(item.status), result: converted.find(m => m.role === 'toolResult'), partialResult: item.type === 'commandExecution' ? { content: [{ type: 'text', text: item.aggregatedOutput || '' }] } : undefined };
      const keys = Object.keys(this.state.tools); if (keys.length > 100) delete this.state.tools[keys[0]];
    }
    while (this.items.size > 300) this.items.delete(this.items.keys().next().value!);
    this.state.messages = [...this.items.values()].flatMap(codexMessages);
    this.state.totalMessageCount = Math.max(this.state.totalMessageCount || 0, this.state.messages.length);
    this.state.hasEarlierMessages = true; this.touch();
  }
  private receive(r: RecordData) {
    if (r.id !== undefined && !r.method) {
      const p = this.pending.get(String(r.id)); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(String(r.id)); r.error ? p.reject(new Error(r.error.message || 'Codex command failed')) : p.resolve(r.result || {}); return;
    }
    const p = r.params || {};
    if (r.id !== undefined && r.method) { this.approval(r); return; }
    if (p.threadId && this.state.sessionId && p.threadId !== this.state.sessionId) return;
    if (r.method === 'thread/started' && p.thread?.id) this.state.sessionId = p.thread.id;
    if (['turn/started', 'turn/completed', 'thread/status/changed'].includes(r.method)) this.lifecycleRevision++;
    if (r.method === 'turn/started') { this.turnId = p.turn.id; this.state.busy = true; }
    if (r.method === 'error') this.state.activity.push({ type: 'diagnostic', text: p.error?.message || 'Codex error', time: Date.now() });
    if (r.method === 'warning') this.state.activity.push({ type: 'diagnostic', text: p.message || 'Codex warning', time: Date.now() });
    if (r.method === 'thread/status/changed' && p.status?.type === 'active') this.state.busy = true;
    if (r.method === 'thread/status/changed' && p.status?.type === 'systemError') { this.state.busy = false; this.state.compaction = undefined; }
    if (r.method === 'turn/completed') {
      this.turnId = undefined; this.state.busy = false; this.state.compaction = undefined; this.manualCompact = false;
      if (p.turn.error) this.state.activity.push({ type: 'diagnostic', text: p.turn.error.message || 'Codex turn failed', time: Date.now() });
      this.approvals.clear(); this.state.dialogs = {};
    }
    if (r.method === 'thread/status/changed' && p.status?.type === 'idle') { this.state.busy = false; this.state.compaction = undefined; this.turnId = undefined; this.manualCompact = false; }
    if (r.method === 'thread/tokenUsage/updated') {
      const u = p.tokenUsage; const tokens = u?.last?.totalTokens;
      this.stats = { sessionId: this.state.sessionId, contextUsage: { tokens: typeof tokens === 'number' ? tokens : null, contextWindow: u?.modelContextWindow || 0, percent: null } };
    }
    if (r.method === 'thread/compacted') { this.state.compaction = undefined; this.manualCompact = false; this.stats = { contextUsage: { tokens: null, contextWindow: this.stats.contextUsage?.contextWindow || 0 } }; }
    if (r.method === 'thread/name/updated') this.state.name = p.threadName || p.name || this.state.name;
    if (r.method === 'serverRequest/resolved') { for (const [key, a] of this.approvals) if (String(a.id) === String(p.requestId)) { this.approvals.delete(key); delete this.state.dialogs[key]; } }
    if (r.method === 'item/started' || r.method === 'item/completed') {
      if (p.item?.type === 'contextCompaction') {
        this.state.compaction = r.method === 'item/started' ? { reason: this.manualCompact ? 'manual' : 'threshold', startedAt: Date.now() } : undefined;
        if (r.method === 'item/started') this.state.busy = true; else if (this.manualCompact) this.state.busy = false;
      }
      this.updateItem(p.item);
    }
    if (['item/agentMessage/delta', 'item/plan/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/commandExecution/outputDelta'].includes(r.method)) {
      const item = this.items.get(p.itemId); if (item) {
        if (item.type === 'reasoning') { const field = r.method.includes('summary') ? 'summary' : 'content'; const index = p.summaryIndex ?? p.contentIndex ?? 0; item[field] ||= []; item[field][index] = (item[field][index] || '') + p.delta; }
        else { const field = item.type === 'commandExecution' ? 'aggregatedOutput' : 'text'; item[field] = (item[field] || '') + (p.delta || ''); }
        this.updateItem(item);
      }
    }
    this.state.activity = this.state.activity.slice(-100); this.touch();
  }
  private approval(r: RecordData) {
    const params = r.params || {};
    if (params.threadId !== this.state.sessionId) { this.write({ id: r.id, error: { code: -32602, message: 'Unknown thread' } }); return; }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'].includes(r.method)) {
      this.write({ id: r.id, error: { code: -32601, message: 'This approval/tool request is not supported by Pi Hub; no permission granted' } });
      this.state.activity.push({ type: 'diagnostic', text: `Unsupported Codex request: ${r.method}`, time: Date.now() }); this.touch(); return;
    }
    const key = `codex:${String(r.id)}`;
    this.approvals.set(key, { id: r.id, method: r.method, params });
    this.state.dialogs[key] = { id: key, method: 'codex', request: r.method, title: r.method === 'item/tool/requestUserInput' ? 'Codex needs your input' : 'Codex approval required', params: { ...params, previewChanges: this.items.get(params.itemId)?.changes || [] } };
    this.touch();
  }
  private async catalog() {
    const models: RecordData[] = []; let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.rpc('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...(result.data || []).filter((m: RecordData) => !m.hidden)); cursor = result.nextCursor; if (!cursor) break;
    }
    this.models = models; return models;
  }
  async command(c: RecordData): Promise<RecordData> {
    const mutation = !['get_commands', 'get_state', 'get_messages', 'get_session_stats', 'get_available_models', 'extension_ui_response', 'abort'].includes(c.type);
    if (mutation && this.commandInFlight) throw new Error('Another Codex control request is pending');
    if (mutation) this.commandInFlight = true;
    try { return { success: true, data: await this.dispatch(c) }; } finally { if (mutation) this.commandInFlight = false; }
  }
  private async dispatch(c: RecordData): Promise<RecordData> {
    if (this.closed) throw new Error('Codex is offline');
    const threadId = this.state.sessionId!;
    switch (c.type) {
      case 'get_commands': return { commands: [] };
      case 'get_state': return { model: { id: this.state.model }, thinkingLevel: this.state.thinking, sessionId: threadId };
      case 'get_messages': return { messages: this.state.messages };
      case 'get_session_stats': return this.stats;
      case 'get_available_models': return { models: (await this.catalog()).map(m => ({ id: m.model || m.id, provider: 'codex', thinkingLevels: (m.supportedReasoningEfforts || []).map((e: RecordData) => e.reasoningEffort) })) };
      case 'set_model': {
        if (this.state.busy) throw new Error('Wait until Codex is idle to change model');
        const model = (await this.catalog()).find(m => (m.model || m.id) === c.modelId);
        if (!model || c.provider !== 'codex') throw new Error('Unknown Codex model');
        this.state.model = model.model || model.id;
        this.state.thinkingLevels = (model.supportedReasoningEfforts || []).map((e: RecordData) => e.reasoningEffort);
        this.state.thinking = model.defaultReasoningEffort; this.touch(); return {};
      }
      case 'set_thinking_level': {
        if (this.state.busy) throw new Error('Wait until Codex is idle to change reasoning effort');
        const model = (this.models.length ? this.models : await this.catalog()).find(m => (m.model || m.id) === this.state.model);
        const levels = (model?.supportedReasoningEfforts || []).map((e: RecordData) => e.reasoningEffort);
        if (!levels.includes(c.level)) throw new Error('Unsupported reasoning effort for this Codex model');
        this.state.thinking = c.level; this.state.thinkingLevels = levels; this.touch(); return {};
      }
      case 'set_session_name':
        if (typeof c.name !== 'string' || !c.name.trim()) throw new Error('Name required');
        await this.rpc('thread/name/set', { threadId, name: c.name.trim().slice(0, 100) }); this.state.name = c.name.trim().slice(0, 100); this.touch(); return {};
      case 'abort':
        if (this.state.busy && !this.turnId) throw new Error('Codex is busy without an interruptible turn ID; wait for the turn or stop this agent process');
        if (this.turnId) await this.rpc('turn/interrupt', { threadId, turnId: this.turnId }); return {};
      case 'compact':
        if (this.state.busy) throw new Error('Wait until Codex is idle to compact');
        if (c.customInstructions) throw new Error('Custom compaction instructions are not supported by Codex');
        this.manualCompact = true;
        try { await this.rpc('thread/compact/start', { threadId }); } catch (e) { this.manualCompact = false; throw e; } return {};
      case 'follow_up': throw new Error('Codex follow-up queues are not supported yet; use steering');
      case 'prompt': case 'steer': {
        if (typeof c.message !== 'string' || !c.message.trim()) throw new Error('Message required');
        if (c.message.trimStart().startsWith('/')) throw new Error('Codex CLI slash commands cannot be sent as model prompts');
        if (c.streamingBehavior === 'followUp') throw new Error('Codex follow-up queues are not supported');
        const input: RecordData[] = [{ type: 'text', text: c.message, text_elements: [] }];
        for (const image of c.images || []) {
          if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType) || typeof image.data !== 'string') throw new Error('Invalid image');
          input.push({ type: 'image', url: `data:${image.mimeType};base64,${image.data}` });
        }
        const clientUserMessageId = randomUUID();
        if (this.state.busy) {
          if (!this.turnId) throw new Error('Codex is busy without a steerable turn; wait until ready');
          await this.rpc('turn/steer', { threadId, expectedTurnId: this.turnId, input, clientUserMessageId });
        } else {
          const revision = this.lifecycleRevision;
          const r = await this.rpc('turn/start', { threadId, input, clientUserMessageId, model: this.state.model, effort: this.state.thinking });
          // Completion may arrive before the ACK: never overwrite an authoritative idle state.
          if (revision === this.lifecycleRevision && !this.turnId && r.turn?.status === 'inProgress') { this.turnId = r.turn.id; this.state.busy = true; this.touch(); }
        }
        return {};
      }
      case 'extension_ui_response': {
        const a = this.approvals.get(c.id); if (!a) throw new Error('Unknown or resolved Codex request');
        let result: RecordData;
        if (a.method === 'item/tool/requestUserInput') {
          const answers: RecordData = {};
          for (const q of a.params.questions || []) {
            const values = c.answers?.[q.id]; if (!Array.isArray(values) || values.some((v: unknown) => typeof v !== 'string')) throw new Error('Answer required for each question');
            answers[q.id] = { answers: values };
          }
          result = { answers };
        } else {
          if (!['accept', 'decline', 'cancel'].includes(c.decision)) throw new Error('Invalid approval decision');
          if (Array.isArray(a.params.availableDecisions) && !a.params.availableDecisions.includes(c.decision)) throw new Error('Decision is not permitted for this request');
          result = { decision: c.decision };
        }
        this.write({ id: a.id, result }); this.approvals.delete(c.id); delete this.state.dialogs[c.id]; this.touch(); return {};
      }
      default: throw new Error('Unsupported Codex control');
    }
  }
  /** Native opaque cursors cross turns; never use Pi's session parser. */
  private historyAnchors = new Map<string, { cursor?: string; itemId: string }>();
  async history(before?: string) {
    const cached = before ? this.historyAnchors.get(before) : undefined;
    const itemId = cached?.itemId || this.state.messages.find(m => messageKey(m) === before)?.codexItemId;
    let cursor = cached?.cursor, found = !before, messages: RecordData[] = [], hasMore = false;
    for (let page = 0; page < 200; page++) {
      let result: RecordData;
      try { result = await this.rpc('thread/items/list', { threadId: this.state.sessionId, limit: MESSAGE_PAGE_SIZE, sortDirection: 'desc', ...(cursor ? { cursor } : {}) }); }
      catch (e) {
        // Codex 0.159.2 has no source rollout until a new thread receives its first turn.
        if (!before && !this.state.messages.length && /missing source rollout/.test((e as Error).message)) return { messages: [], hasMore: false, limited: false, sessionId: this.state.sessionId };
        throw e;
      }
      const converted: RecordData[] = [];
      for (const entry of [...(result.data || [])].reverse()) for (const m of codexMessages(entry.item)) {
        converted.push(m); this.historyAnchors.set(messageKey(m), { cursor, itemId: entry.item.id });
      }
      if (!found) {
        let index = converted.findIndex(m => messageKey(m) === before);
        if (index < 0 && itemId) index = converted.findIndex(m => m.codexItemId === itemId);
        if (index >= 0) { found = true; messages = converted.slice(0, index); }
      } else messages = [...converted, ...messages];
      hasMore = !!result.nextCursor || messages.length > MESSAGE_PAGE_SIZE;
      while (this.historyAnchors.size > 2000) this.historyAnchors.delete(this.historyAnchors.keys().next().value!);
      if (found && (messages.length >= MESSAGE_PAGE_SIZE || !result.nextCursor)) return { messages: messages.slice(-MESSAGE_PAGE_SIZE), hasMore, limited: false, sessionId: this.state.sessionId };
      if (!result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    throw new Error('Codex history cursor changed or is too far back. Return to latest messages and try again.');
  }
}
