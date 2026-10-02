import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { WebSocket } from 'ws';
import { hostname } from 'node:os';
import { attachedAgentId } from '../shared/agent-identity.js';
import { loadConfig } from '../server/config.js';
import type { RecordData } from '../shared/state.js';
import { sessionUsage } from '../shared/usage.js';

/** Outbound-only connection. Never starts a server inside a Pi process. */
export default function (pi: ExtensionAPI) {
  const connectionId = attachedAgentId();
  let ctx: ExtensionContext | undefined;
  let socket: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let stopped = true;
  let delay = 1000;
  const queued = { steering: [] as string[], followUp: [] as string[] };
  const publishQueue = () => send({ type: 'event', event: { type: 'queue_update', ...queued, estimated: true } });
  const observerId = process.env.PI_HUB_OBSERVER_ID;
  const send = (r: unknown) => {
    if (socket?.readyState === WebSocket.OPEN) {
      if (socket.bufferedAmount > 32 * 1024 * 1024) { socket.terminate(); return; }
      socket.send(JSON.stringify(r));
    }
  };
  function snapshot(settled = false) {
    if (!ctx || observerId) return;
    const messages = ctx.sessionManager.getBranch().filter(e => e.type === 'message').map(e => (e as any).message);
    send({ type: 'snapshot', state: {
      name: pi.getSessionName() || ctx.cwd.split('/').pop() || 'Pi agent',
      cwd: ctx.cwd, host: hostname(), busy: settled ? false : !ctx.isIdle(),
      model: ctx.model?.id, thinking: pi.getThinkingLevel(),
      messages: messages.slice(-300), totalMessageCount: messages.length,
      sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(),
      queue: { ...queued, estimated: true, tracked: true },
    } });
  }
  async function command(c: RecordData) {
    try {
      if (!ctx) throw new Error('Session not ready');
      let data: unknown;
      switch (c.type) {
        case 'prompt': case 'steer': case 'follow_up': {
          if (typeof c.message !== 'string') throw new Error('Message required');
          // Expansion is opt-in for extension messages. Dispatch only known commands:
          // TUI-only built-ins and typos must never become accidental model prompts.
          const slash = /^\/([^\s]+)/.exec(c.message);
          let extensionCommand = false;
          if (slash) {
            const registered = pi.getCommands().find(command => command.name === slash[1]);
            if (!registered) throw new Error(`Unknown or CLI-only command: /${slash[1]}`);
            extensionCommand = registered.source === 'extension';
            if (c.type !== 'prompt' && registered.source === 'extension') throw new Error('Extension commands must be sent as a prompt, not queued as steering or follow-up.');
          }
          const content: any[] = [{ type: 'text', text: c.message }];
          for (const image of c.images || []) {
            if (!['image/png','image/jpeg','image/webp','image/gif'].includes(image.mimeType) || typeof image.data !== 'string') throw new Error('Invalid image');
            content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
          }
          const deliverAs = c.type === 'follow_up' ? 'followUp' : c.type === 'steer' ? 'steer' : c.streamingBehavior;
          if (extensionCommand) {
            // Commands such as /hub-off can tear down this connection. Flush the
            // acceptance ACK first; it does not claim the command has completed.
            const ws = socket;
            if (ws?.readyState !== WebSocket.OPEN) throw new Error('Hub connection closed');
            await new Promise<void>((resolve, reject) => ws.send(JSON.stringify({ type: 'response', id: c.id, command: c.type, success: true }), error => error ? reject(error) : resolve()));
          }
          pi.sendUserMessage(content, { expandPromptTemplates: true, ...(!ctx.isIdle() || c.type !== 'prompt' ? { deliverAs: deliverAs || 'steer' } : {}) });
          if (extensionCommand) { snapshot(); return; }
          break;
        }
        case 'abort': ctx.abort(); break;
        case 'get_state': data = { model: ctx.model, thinkingLevel: pi.getThinkingLevel(), isStreaming: !ctx.isIdle(), sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId() }; break;
        case 'get_session_stats': data = { ...sessionUsage(ctx.sessionManager.getEntries()), contextUsage: ctx.getContextUsage(), sessionId: ctx.sessionManager.getSessionId() }; break;
        case 'get_messages': data = { messages: ctx.sessionManager.getBranch().filter(e => e.type === 'message').map(e => (e as any).message) }; break;
        case 'get_available_models': data = { models: ctx.modelRegistry.getAvailable() }; break;
        case 'get_commands': data = { commands: pi.getCommands() }; break;
        case 'set_session_name':
          if (typeof c.name !== 'string' || !c.name.trim()) throw new Error('Name required');
          pi.setSessionName(c.name.slice(0, 100)); break;
        case 'set_model': {
          const model = ctx.modelRegistry.getAvailable().find(m => m.provider === c.provider && m.id === c.modelId);
          if (!model || !await pi.setModel(model)) throw new Error('Model unavailable');
          break;
        }
        case 'set_thinking_level': {
          if (!['off','minimal','low','medium','high','xhigh','max'].includes(c.level)) throw new Error('Invalid thinking level');
          pi.setThinkingLevel(c.level); break;
        }
        case 'compact':
          if (!ctx.isIdle()) throw new Error('Wait until idle to compact');
          await new Promise<void>((resolve, reject) => ctx!.compact({ customInstructions: c.customInstructions, onComplete: () => resolve(), onError: reject })); break;
        default: throw new Error('Unsupported attached-agent command');
      }
      send({ type: 'response', id: c.id, command: c.type, success: true, data });
      if (c.type !== 'get_session_stats') snapshot();
    } catch (error) { send({ type: 'response', id: c.id, command: c.type, success: false, error: error instanceof Error ? error.message : 'Command failed' }); }
  }
  function connect() {
    if (stopped) return;
    let config;
    try { config = loadConfig(); } catch { ctx?.ui.setStatus('hub', 'Hub: run npm run setup'); return; }
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/agent`, { headers: { Authorization: `Bearer ${config.agentToken}` }, maxPayload: 16 * 1024 * 1024 });
    socket = ws;
    let lastPong = Date.now();
    ws.on('open', () => {
      if (stopped || socket !== ws) { ws.terminate(); return; }
      delay = 1000;
      send({ type: 'register', id: observerId || connectionId, observer: !!observerId,
        metadata: { name: pi.getSessionName() || 'Pi agent', cwd: ctx?.cwd, host: hostname(), sessionId: ctx?.sessionManager.getSessionId(), sessionFile: ctx?.sessionManager.getSessionFile() } });
      snapshot();
      if (!observerId) ctx?.ui.setStatus('hub', 'Hub: connected');
      heartbeat = setInterval(() => { if (Date.now() - lastPong > 65_000) ws.terminate(); else ws.ping(); }, 25_000);
    });
    ws.on('pong', () => { lastPong = Date.now(); });
    ws.on('message', raw => {
      if (socket !== ws) return;
      try { const r = JSON.parse(raw.toString()); if (r.type === 'command' && !observerId) void command(r.command); }
      catch { ws.close(1008, 'Invalid command'); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (socket !== ws) return;
      socket = undefined;
      clearInterval(heartbeat); heartbeat = undefined;
      if (!observerId) ctx?.ui.setStatus('hub', 'Hub: reconnecting');
      if (!stopped) { retry = setTimeout(connect, delay + Math.random() * 500); delay = Math.min(delay * 2, 30_000); }
    });
  }
  function stop() {
    stopped = true; clearTimeout(retry); clearInterval(heartbeat); socket?.terminate(); socket = undefined;
    ctx?.ui.setStatus('hub', undefined);
  }
  pi.on('session_start', (_e, context) => { ctx = context; if (stopped) { stopped = false; connect(); } else snapshot(); });
  pi.on('session_shutdown', stop);
  pi.on('input', (event, context) => {
    ctx = context;
    if (!observerId && !context.isIdle() && event.streamingBehavior) {
      queued[event.streamingBehavior === 'followUp' ? 'followUp' : 'steering'].push(event.text);
      publishQueue();
    }
  });
  pi.registerCommand('hub', { description: 'Connect/reconnect this agent to Pi Hub', handler: async (_args, context) => { stop(); ctx = context; stopped = false; connect(); } });
  pi.registerCommand('hub-off', { description: 'Disconnect this agent from Pi Hub', handler: async () => stop() });
  const events = ['agent_start','agent_end','agent_settled','message_start','message_update','message_end','tool_execution_start','tool_execution_update','tool_execution_end','session_info_changed','session_compact','model_select'] as const;
  for (const type of events) pi.on(type as any, (event: any, context: ExtensionContext) => {
    ctx = context;
    if (observerId) return;
    if (type === 'message_start' && event.message?.role === 'user') {
      const text = typeof event.message.content === 'string' ? event.message.content : event.message.content?.filter((b: RecordData) => b.type === 'text').map((b: RecordData) => b.text).join('\n');
      for (const mode of ['steering', 'followUp'] as const) { const index = queued[mode].indexOf(text); if (index >= 0) { queued[mode].splice(index, 1); publishQueue(); break; } }
    }
    if (type === 'agent_settled') { queued.steering.length = 0; queued.followUp.length = 0; publishQueue(); }
    send({ type: 'event', event });
    if (['agent_settled', 'session_compact', 'model_select', 'session_info_changed'].includes(type)) snapshot(type === 'agent_settled');
  });
  // pi-subagents exposes these lifecycle events on Pi's shared event bus.
  for (const type of ['subagent:async-started','subagent:async-complete','subagent:foreground-complete','subagent:child-status','subagents:rpc:v1:ready']) {
    pi.events.on(type, payload => send({ type: 'event', event: { type, payload } }));
  }
}
