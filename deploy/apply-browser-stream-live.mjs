#!/usr/bin/env node
// Apply ONLY the outbound browser adapter to a running Hub; never restart agents.
// Usage: node deploy/apply-browser-stream-live.mjs HUB_NODE_PID
// The ordinary server startup installs the same adapter after future restarts.
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import WebSocket from 'ws';

const pid = Number(process.argv[2]);
if (!Number.isInteger(pid) || pid < 2) throw Error('Pass the Hub backend Node PID (not the tsx supervisor)');
const command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
if (!command.split('\0').includes(new URL('../server/cli.ts', import.meta.url).pathname)) throw Error('PID is not the expected Pi Hub backend');
const bundle = new URL('../dist/server/browser-stream.mjs', import.meta.url);
await build({ entryPoints: [new URL('../server/browser-stream.ts', import.meta.url).pathname], outfile: bundle.pathname,
  bundle: true, platform: 'node', format: 'iife', globalName: 'browserStream', packages: 'external' });
const targets = async () => (await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(1000) })).json();
let list, opened = false;
try { list = await targets(); } catch {
  process.kill(pid, 'SIGUSR1'); opened = true;
  for (let i = 0; i < 30; i++) { await delay(100); try { list = await targets(); break; } catch {} }
}
if (!list?.[0]) throw Error('Loopback Node inspector did not become available');
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
let sequence = 0; const pending = new Map();
ws.on('message', raw => {
  const message = JSON.parse(raw), request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id); clearTimeout(request.timer);
  if (message.error || message.result?.exceptionDetails) request.reject(Error(`${request.method}: ${message.error?.message || message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text}`));
  else request.resolve(message.result);
});
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`Inspector timeout: ${method}`)); }, 10_000);
  pending.set(id, { resolve, reject, timer, method }); ws.send(JSON.stringify({ id, method, params }));
});
let verified = false;
try {
  const identity = await rpc('Runtime.evaluate', { expression: 'process.pid', returnByValue: true });
  if (identity.result.value !== pid) throw Error('Inspector belongs to a different process; refusing modification');
  verified = true;
  const handler = await rpc('Runtime.evaluate', { expression: "process._getActiveHandles().find(h=>h.constructor?.name==='Server'&&h.listeners('upgrade').length).listeners('upgrade')[0]" });
  const properties = await rpc('Runtime.getProperties', { objectId: handler.result.objectId });
  const scopes = await rpc('Runtime.getProperties', { objectId: properties.internalProperties.find(p => p.name === '[[Scopes]]').value.objectId });
  let server;
  for (const scope of scopes.result) {
    if (!scope.value?.objectId || !scope.value.description?.includes('createHub')) continue;
    const variables = await rpc('Runtime.getProperties', { objectId: scope.value.objectId });
    server = variables.result.find(p => p.name === 'wss' && p.value?.className === 'WebSocketServer');
    if (server) break;
  }
  if (!server) throw Error('Browser WebSocket server not found; nothing modified');
  const source = await readFile(bundle, 'utf8');
  const module = await rpc('Runtime.evaluate', { expression: `(function(){\n${source}\nreturn browserStream.installBrowserStream;})()` });
  const result = await rpc('Runtime.callFunctionOn', { objectId: server.value.objectId,
    functionDeclaration: 'function(install) { return install(this); }',
    arguments: [{ objectId: module.result.objectId }], returnByValue: true });
  console.log('Browser adapter:', result.result.value);
} finally {
  // Do not leave a new unauthenticated local debugging listener behind, and do
  // not close an inspector that was already being used by the owner.
  if (opened && verified) await rpc('Runtime.evaluate', { expression: "setTimeout(()=>process.getBuiltinModule('inspector').close(),200);'closing inspector'" });
  ws.close();
}
