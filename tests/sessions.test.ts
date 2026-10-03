import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createConfig } from '../server/config.js';
import { createHub } from '../server/hub.js';
import { emptyAgent } from '../shared/state.js';
import { CodexAgent } from '../server/codex.js';
import { hostname } from 'node:os';

async function setup() {
  const temp = await mkdtemp(path.join(tmpdir(), 'pi-hub-sessions-')), root = path.join(temp, 'projects'), workspace = path.join(root, 'work'), agentDir = path.join(temp, 'pi');
  await mkdir(workspace, { recursive: true }); await mkdir(agentDir);
  const env = { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: undefined, PI_HUB_CODEX_TEST_LEGACY: undefined, PI_HUB_CODEX_TEST_STATUS: undefined, PI_HUB_CODEX_BIN: path.join(temp, 'codex.mjs'), PI_HUB_PI_BIN: path.join(temp, 'pi.mjs'), PI_HUB_CODEX_TEST_LOG: path.join(temp, 'codex.log'), PI_HUB_PI_TEST_LOG: path.join(temp, 'pi.log'), PI_HUB_CODEX_TEST_CWD: workspace };
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : process.env[k] = v;
  for (const [bin, fixture] of [[env.PI_HUB_CODEX_BIN, 'codex-app-server.mjs'], [env.PI_HUB_PI_BIN, 'pi-rpc.mjs']]) { await writeFile(bin!, await readFile(new URL('./fixtures/' + fixture, import.meta.url))); await chmod(bin!, 0o700); }
  const manager = SessionManager.create(workspace); manager.appendModelChange('test', 'saved-pi-model'); manager.appendThinkingLevelChange('high');
  for (let i = 0; i < 90; i++) manager.appendMessage({ role: 'user', content: `Saved Pi message ${i}`, timestamp: 1700000000000 + i });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Saved Pi answer' }], api: 'openai-responses', provider: 'test', model: 'saved-pi-model', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 1700000001000 });
  manager.appendSessionInfo('Saved Pi');
  const file = manager.getSessionFile()!;
  const config = createConfig('test-password-long', root); config.port = 0;
  const hub = createHub(config); hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening'); config.port = (hub.server.address() as any).port;
  const base = `http://127.0.0.1:${config.port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base }, body: JSON.stringify({ password: 'test-password-long' }) }); const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const get = (route: string) => fetch(base + '/api/' + route, { headers: { Cookie: cookie } });
  const post = (data: unknown, origin = base) => fetch(base + '/api/sessions/resume', { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: JSON.stringify(data) });
  return { temp, root, workspace, agentDir, hub, base, cookie, get, post, file, sessionId: manager.getSessionId(), env, async cleanup() { await hub.close(); await new Promise(r => setTimeout(r, 60)); for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k] = v; await rm(temp, { recursive: true, force: true }); } };
}

test('saved session discovery is authenticated, workspace-confined, searchable, engine-aware and does not start threads', async () => {
  const f = await setup();
  try {
    assert.equal((await fetch(f.base + '/api/sessions')).status, 401);
    assert.equal((await f.get('sessions?engine=wrong')).status, 400);
    assert.equal((await f.get('sessions?cwd=/')).status, 400);
    const page = await (await f.get('sessions')).json(); assert.deepEqual(page.warnings, []);
    assert.deepEqual(page.sessions.map((s: any) => s.name).sort(), ['Saved Codex', 'Saved Pi']);
    assert.ok(page.sessions.every((s: any) => !s.file && s.cwd === f.workspace));
    assert.equal((await (await f.get('sessions?engine=codex')).json()).sessions.length, 1);
    assert.equal((await (await f.get('sessions?q=' + encodeURIComponent('Pi answer'))).json()).sessions.length, 0); // Search is metadata, not whole transcript.
    assert.equal((await (await f.get('sessions?q=Saved%20Pi')).json()).sessions.length, 1);
    const calls = (await readFile(f.env.PI_HUB_CODEX_TEST_LOG, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.ok(calls.every(c => !['thread/start', 'thread/resume', 'turn/start'].includes(c.method)));
    assert.equal((await f.post({ key: '/arbitrary/session.jsonl' })).status, 400);
    assert.equal((await f.post({ key: page.sessions[0].key }, 'https://wrong.invalid')).status, 403);
  } finally { await f.cleanup(); }
});

test('Pi resume uses the saved file, restores history/name/model, coalesces simultaneous requests and opens existing attached sessions', async () => {
  const f = await setup();
  try {
    const choice = (await (await f.get('sessions?engine=pi')).json()).sessions[0];
    const [first, second] = await Promise.all([f.post({ key: choice.key }).then(r => r.json()), f.post({ key: choice.key }).then(r => r.json())]);
    assert.equal(first.id, second.id); assert.ok(first.id);
    const state = f.hub.agents.get(first.id)!; assert.equal(state.sessionId, f.sessionId); assert.equal(state.name, 'Saved Pi'); assert.equal(state.model, 'saved-pi-model'); assert.equal(state.messages.length, 40); assert.equal(state.messages.at(-1)?.content[0].text, 'Saved Pi answer');
    const calls = (await readFile(f.env.PI_HUB_PI_TEST_LOG, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(calls.filter(c => c.args).length, 1); assert.ok(!calls[0].args.includes('--name')); assert.ok(calls[0].args.includes(f.file)); assert.ok(!calls.some(c => c.type === 'prompt'));
    assert.equal((await (await f.post({ key: choice.key })).json()).id, state.id);
    // Mimic a live terminal attachment with the same saved file, even through a metadata alias.
    state.online = false; const attached = emptyAgent('attached'); Object.assign(attached, { cwd: f.workspace, host: hostname(), sessionId: f.sessionId, sessionFile: f.file }); f.hub.agents.set(attached.id, attached);
    assert.equal((await (await f.post({ key: choice.key })).json()).id, attached.id);
  } finally { await f.cleanup(); }
});

test('Codex resume preserves its name/reasoning, hydrates cross-turn history and keeps saved messages when new output arrives', async () => {
  const f = await setup();
  try {
    const choice = (await (await f.get('sessions?engine=codex')).json()).sessions[0];
    const [first, second] = await Promise.all([f.post({ key: choice.key }).then(r => r.json()), f.post({ key: choice.key }).then(r => r.json())]); assert.equal(first.id, second.id);
    const state = f.hub.agents.get(first.id)!; assert.equal(state.sessionId, 'thread-saved'); assert.equal(state.name, 'Saved Codex'); assert.equal(state.thinking, 'high'); assert.equal(state.messages.length, 40);
    const calls = (await readFile(f.env.PI_HUB_CODEX_TEST_LOG, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(calls.filter(c => c.method === 'thread/resume').length, 1); assert.ok(!calls.some(c => ['thread/start', 'thread/name/set', 'turn/start'].includes(c.method)));
    const resume = calls.find(c => c.method === 'thread/resume'); assert.deepEqual(resume.params, { threadId: 'thread-saved', excludeTurns: true });
    const agent = emptyAgent('direct'); agent.cwd = f.workspace; const adapter = new CodexAgent(agent, () => {});
    try { await adapter.start('thread-saved'); await adapter.command({ type: 'prompt', message: 'Fixture-only test' }); assert.ok(agent.messages.some(m => m.content?.[0]?.text === 'Saved message 89')); assert.ok(agent.messages.some(m => m.content?.[0]?.text === 'Streamed response')); } finally { adapter.stop(); }
  } finally { await f.cleanup(); }
});

test('session pagination searches beyond the first page and rejects stale/filter-mismatched cursors and deleted choices', async () => {
  const f = await setup();
  try {
    const original = (await (await f.get('sessions?engine=pi')).json()).sessions[0];
    const dir = path.dirname(f.file), originalText = await readFile(f.file, 'utf8');
    for (let i = 0; i < 60; i++) await writeFile(path.join(dir, `copy-${i}.jsonl`), originalText.replace(f.sessionId, 'copy-' + i).replace('Saved Pi"', `Copy ${i}"`));
    const page = await (await f.get('sessions?engine=pi&refresh=1')).json(); assert.equal(page.sessions.length, 50); assert.ok(page.cursor);
    const next = await (await f.get('sessions?engine=pi&cursor=' + encodeURIComponent(page.cursor))).json(); assert.equal(next.sessions.length, 11);
    assert.equal(new Set([...page.sessions, ...next.sessions].map((s: any) => s.key)).size, 61);
    assert.equal((await f.get('sessions?engine=codex&cursor=' + encodeURIComponent(page.cursor))).status, 400);
    assert.equal((await f.get('sessions?engine=pi&q=Copy&cursor=' + encodeURIComponent(page.cursor))).status, 400);
    assert.equal((await (await f.get('sessions?engine=pi&q=Copy%2059')).json()).sessions.length, 1);
    await rm(f.file); assert.equal((await f.post({ key: original.key })).status, 400); assert.equal(f.hub.agents.size, 0);
  } finally { await f.cleanup(); }
});


test('custom Pi storage is discoverable and active external Codex threads are rejected', async () => {
  const f = await setup();
  try {
    const custom = path.join(f.temp, 'custom-storage'); await mkdir(custom); await mkdir(path.join(f.workspace, '.pi'));
    await writeFile(path.join(f.workspace, '.pi/settings.json'), JSON.stringify({ sessionDir: custom }));
    await writeFile(path.join(custom, 'custom.jsonl'), (await readFile(f.file, 'utf8')).replace(f.sessionId, 'custom-session').replace('Saved Pi"', 'Custom Pi"'));
    const scoped = await (await f.get('sessions?engine=pi&cwd=' + encodeURIComponent(f.workspace))).json();
    assert.deepEqual(scoped.sessions.map((s: any) => s.name), ['Custom Pi']);
    const all = await (await f.get('sessions?engine=pi')).json(); assert.equal(all.sessions.length, 2);
    const choice = (await (await f.get('sessions?engine=codex')).json()).sessions[0];
    process.env.PI_HUB_CODEX_TEST_STATUS = 'active';
    const blocked = await f.post({ key: choice.key }); assert.equal(blocked.status, 400); assert.match((await blocked.json()).error, /active elsewhere/); assert.equal(f.hub.agents.size, 0);
  } finally { await f.cleanup(); }
});

test('legacy Codex CLI sessions hydrate native turns instead of unsupported item pagination', async () => {
  const f = await setup(); process.env.PI_HUB_CODEX_TEST_LEGACY = '1';
  try {
    const choice = (await (await f.get('sessions?engine=codex')).json()).sessions[0];
    const result = await (await f.post({ key: choice.key })).json(); assert.ok(result.id);
    const state = f.hub.agents.get(result.id)!; assert.equal(state.messages.length, 40);
    const { messageKey } = await import('../shared/history.js');
    const page = await (await f.get(`agents/${state.id}/history?before=${encodeURIComponent(messageKey(state.messages[0]))}`)).json();
    assert.equal(page.messages.length, 40); assert.equal(page.messages.at(-1).content[0].text, 'Saved message 49');
    const calls = (await readFile(f.env.PI_HUB_CODEX_TEST_LOG, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.ok(calls.some(c => c.method === 'thread/read' && c.params.includeTurns)); assert.ok(!calls.some(c => c.method === 'thread/items/list'));
  } finally { await f.cleanup(); }
});
