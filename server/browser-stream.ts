import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { AgentStreamEncoder } from '../shared/agent-stream.js';
import type { RecordData } from '../shared/state.js';

const installed = Symbol.for('pi-hub.browser-stream.v1');
const attached = Symbol.for('pi-hub.browser-stream.socket.v1');

// Keep slow browsers from accumulating snapshots until the Hub's 32 MB socket
// guard disconnects them and resends the entire inventory in a reconnect loop.
// Coalesce BEFORE encoding: a delta baseline must describe actually sent data.
export function attachBrowserStream(ws: WebSocket, incremental: boolean) {
  const socket = ws as WebSocket & { [attached]?: boolean };
  if (socket[attached]) return;
  socket[attached] = true;
  const original = ws.send.bind(ws);
  const encoder = incremental ? new AgentStreamEncoder() : undefined;
  const pending = new Map<string, string>();
  const sentAt = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = () => { if (!timer && !stopped && pending.size) { timer = setTimeout(pump, 25); timer.unref(); } };
  function pump() {
    timer = undefined;
    if (stopped || ws.readyState !== 1) return;
    // Only one large snapshot can be in the transport at a time. Commands and
    // replies are not coalesced and do not wait behind an application-side queue.
    for (const [key, data] of pending) {
      if (ws.bufferedAmount > 64 * 1024) break;
      if (Date.now() - (sentAt.get(key) || 0) < (incremental ? 250 : 1000)) continue;
      pending.delete(key);
      const record: RecordData = JSON.parse(data);
      const encoded = encoder ? encoder.encode(record) : record;
      if (encoded) original(JSON.stringify(encoded));
      sentAt.set(key, Date.now());
    }
    schedule();
  }
  ws.send = ((data: unknown, ...rest: unknown[]) => {
    // Preserve every other ws.send overload/callback and all command replies.
    if (typeof data !== 'string' || rest.length) return (original as Function)(data, ...rest);
    let record: RecordData;
    try { record = JSON.parse(data); } catch { return original(data); }
    if (!['agent', 'agents'].includes(record.type)) return original(data);
    if (stopped || ws.readyState !== 1) return;
    const key = record.type === 'agent' ? `agent:${record.agent.id}` : 'inventory';
    if (record.type === 'agents') {
      const ids = new Set(record.agents.map((agent: RecordData) => `agent:${agent.id}`));
      for (const old of pending.keys()) if (old !== 'inventory' && !ids.has(old)) pending.delete(old);
      for (const old of sentAt.keys()) if (old !== 'inventory' && !ids.has(old)) sentAt.delete(old);
    }
    pending.set(key, data);
    schedule();
  }) as WebSocket['send'];
  ws.once('close', () => { stopped = true; clearTimeout(timer); pending.clear(); sentAt.clear(); });
}

// Isolated installation also permits applying this outbound-only adapter to a
// running Hub without replacing its server, authentication, or agent processes.
export function installBrowserStream(wss: WebSocketServer) {
  const server = wss as WebSocketServer & { [installed]?: boolean };
  if (server[installed]) return { installed: false, existing: wss.clients.size };
  server[installed] = true;
  wss.prependListener('connection', (ws: WebSocket, req: IncomingMessage) => {
    const incremental = new URL(req.url || '/', 'http://localhost').searchParams.get('updates') === 'delta-v1';
    attachBrowserStream(ws, incremental);
  });
  // Already-open/old clients have no negotiated delta support.
  for (const ws of wss.clients) attachBrowserStream(ws, false);
  return { installed: true, existing: wss.clients.size };
}
