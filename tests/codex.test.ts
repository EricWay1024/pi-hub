import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { emptyAgent } from '../shared/state.js';
import { codexMessages } from '../shared/codex.js';
import { commandList } from '../shared/commands.js';
import { messageKey, mergeMessages } from '../shared/history.js';
import { CodexAgent } from '../server/codex.js';
import { createHub } from '../server/hub.js';
import { createConfig } from '../server/config.js';

async function fixture() {
  const temp = await mkdtemp(path.join(tmpdir(), 'pi-hub-codex-test-'));
  const bin = path.join(temp, 'fake-codex.mjs'), log = path.join(temp, 'calls.jsonl');
  await writeFile(bin, await readFile(new URL('./fixtures/codex-app-server.mjs', import.meta.url))); await chmod(bin, 0o700);
  const old = process.env.PI_HUB_CODEX_BIN, oldLog = process.env.PI_HUB_CODEX_TEST_LOG;
  process.env.PI_HUB_CODEX_BIN = bin; process.env.PI_HUB_CODEX_TEST_LOG = log;
  return { temp, log, async cleanup() { old === undefined ? delete process.env.PI_HUB_CODEX_BIN : process.env.PI_HUB_CODEX_BIN = old; oldLog === undefined ? delete process.env.PI_HUB_CODEX_TEST_LOG : process.env.PI_HUB_CODEX_TEST_LOG = oldLog; await rm(temp, { recursive: true, force: true }); } };
}
test('Codex items use stable live/history identities and readable tools', () => {
  const first = codexMessages({ type: 'agentMessage', id: 'one', text: 'Part' })[0], last = codexMessages({ type: 'agentMessage', id: 'one', text: 'Complete' })[0];
  assert.equal(messageKey(first), messageKey(last)); assert.equal(mergeMessages([first], [last]).length, 1);
  const shell = codexMessages({ type: 'commandExecution', id: 'shell', command: 'false', status: 'completed', aggregatedOutput: 'Failed', exitCode: 1 });
  assert.equal(shell[1].isError, true); assert.equal(shell[0].content[0].name, 'bash');
  const patch = codexMessages({ type: 'fileChange', id: 'patch', status: 'completed', changes: [{ path: 'a.ts', diff: '-old\n+new' }] });
  assert.match(patch[1].details.patch, /\+new/);
  assert.ok(!commandList([], 'codex').some(c => c.name === 'reload')); assert.ok(commandList([], 'pi').some(c => c.name === 'reload'));
});
test('Codex adapter maps controls, approvals, token usage and cross-turn paginated history without replay', async () => {
  const f = await fixture(), state = emptyAgent('codex'); state.cwd = f.temp; state.engine = 'codex'; state.name = 'Codex test';
  const adapter = new CodexAgent(state, () => {});
  try {
    await adapter.start(); assert.equal(state.model, 'test-model'); assert.deepEqual(state.thinkingLevels, ['medium', 'high']);
    await adapter.command({ type: 'set_thinking_level', level: 'high' });
    await assert.rejects(adapter.command({ type: 'set_thinking_level', level: 'xhigh' }), /Unsupported/);
    await adapter.command({ type: 'prompt', message: 'hello' });
    assert.equal(state.busy, false); assert.ok(state.messages.some(m => m.content?.[0]?.text === 'Streamed response'));
    assert.equal((await adapter.command({ type: 'get_session_stats' })).data.contextUsage.tokens, 45000);
    await assert.rejects(adapter.command({ type: 'follow_up', message: 'Later' }), /not supported/);
    await assert.rejects(adapter.command({ type: 'prompt', message: '/login' }), /slash/);
    await adapter.command({ type: 'prompt', message: 'block' }); assert.equal(state.busy, true);
    const dialog = Object.values(state.dialogs)[0]; assert.equal(dialog.params.command, 'echo test');
    await assert.rejects(adapter.command({ type: 'extension_ui_response', id: dialog.id, decision: 'acceptForSession' }), /Invalid/);
    await adapter.command({ type: 'extension_ui_response', id: dialog.id, decision: 'accept' }); assert.equal(Object.keys(state.dialogs).length, 0);
    await assert.rejects(adapter.command({ type: 'extension_ui_response', id: dialog.id, decision: 'accept' }), /Unknown/);
    await adapter.command({ type: 'steer', message: 'Keep going' }); await adapter.command({ type: 'abort' }); assert.equal(state.busy, false);
    await adapter.command({ type: 'compact' }); assert.equal(state.compaction, undefined); assert.equal(state.busy, false);
    assert.equal((await adapter.command({ type: 'get_session_stats' })).data.contextUsage.tokens, null);
    const latest = await adapter.history(); assert.equal(latest.messages.length, 40); assert.equal(latest.messages.at(-1)?.content[0].text, 'Saved message 89');
    const older = await adapter.history(messageKey(latest.messages[0])); assert.equal(older.messages.length, 40); assert.equal(older.messages.at(-1)?.content[0].text, 'Saved message 49');
    const earliest = await adapter.history(messageKey(older.messages[0])); assert.equal(earliest.messages.length, 10); assert.equal(earliest.hasMore, false);
    const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const start = calls.find(c => c.method === 'thread/start'); assert.equal(start.params.sandbox, undefined); assert.equal(start.params.approvalPolicy, undefined);
    assert.equal(calls.filter(c => c.method === 'turn/start').length, 2); assert.equal(calls.find(c => c.method === 'turn/steer').params.expectedTurnId, 'turn-live-2');
    assert.ok(calls.some(c => c.id === 900 && c.result?.decision === 'accept'));
    const unconfirmed = adapter.command({ type: 'prompt', message: 'hang' });
    const rejected = assert.rejects(unconfirmed, /stopped|exited/);
    for (let i = 0; i < 50 && !state.busy; i++) await new Promise(r => setTimeout(r, 10));
    adapter.stop(); await rejected;
    assert.equal(state.online, false); assert.equal(state.busy, false);
    assert.equal((await readFile(f.log, 'utf8')).split('\n').filter(line => line.includes('"method":"turn/start"')).length, 3);
  } finally { adapter.stop(); await new Promise(r => setTimeout(r, 50)); await f.cleanup(); }
});
test('Hub launches independent Codex agents with authenticated engine selection and confines paths', async () => {
  const f = await fixture(), config = createConfig('test-password-long', f.temp); config.port = 0;
  const hub = createHub(config); hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening'); config.port = (hub.server.address() as any).port;
  const base = `http://127.0.0.1:${config.port}`; let ws: WebSocket | undefined;
  const post = (route: string, data: any, cookie = '') => fetch(base + '/api/' + route, { method: 'POST', headers: { Origin: base, Cookie: cookie }, body: JSON.stringify(data) });
  try {
    assert.equal((await post('agents', { engine: 'codex', cwd: f.temp })).status, 401);
    const login = await post('login', { password: 'test-password-long' }), cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await post('agents', { engine: 'unknown', cwd: f.temp }, cookie)).status, 400);
    assert.equal((await post('agents', { engine: 'codex', cwd: '/' }, cookie)).status, 400);
    const a = await (await post('agents', { engine: 'codex', cwd: f.temp }, cookie)).json(), b = await (await post('agents', { engine: 'codex', cwd: f.temp }, cookie)).json();
    assert.equal(hub.agents.get(a.id)?.engine, 'codex'); assert.equal(hub.agents.get(b.id)?.online, true);
    ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Origin: base, Cookie: cookie } }); await once(ws, 'open');
    const reply = new Promise<any>(resolve => { ws!.on('message', raw => { const r = JSON.parse(raw.toString()); if (r.type === 'reply' && r.id === 'stop-a') resolve(r); }); });
    ws.send(JSON.stringify({ type: 'stop', agentId: a.id, id: 'stop-a' })); assert.equal((await reply).success, true);
    assert.equal(hub.agents.get(a.id)?.online, false); assert.equal(hub.agents.get(b.id)?.online, true);
    const page = await (await fetch(base + `/api/agents/${b.id}/history`, { headers: { Cookie: cookie } })).json(); assert.equal(page.messages.length, 40);
  } finally { ws?.terminate(); await hub.close(); await new Promise(r => setTimeout(r, 50)); await f.cleanup(); }
});
