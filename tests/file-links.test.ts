import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileLink } from '../shared/file-links.js';
import { FileLinkContext, RichText } from '../web/RichText.js';
import { createHub } from '../server/hub.js';
import { createConfig } from '../server/config.js';
import { emptyAgent } from '../shared/state.js';

test('local Markdown links preserve paths and line anchors without enabling unsafe protocols', () => {
  for (const link of ['notes/a.md', './notes/a.md', '/home/user/project/a.md', 'file:///home/user/project/a.md', 'sandbox:/home/user/project/a.md', '../a.md']) assert.ok(fileLink(link, 'agent')?.startsWith('/api/files?agentId=agent&path='));
  assert.equal(new URL(fileLink('file:///home/user/project/a%20b.md#L15', 'agent')!, 'http://hub').searchParams.get('path'), '/home/user/project/a b.md');
  assert.ok(fileLink('src/a.ts:12:3', 'agent')?.endsWith('#L12'));
  for (const link of ['https://example.com/a.md', 'mailto:me@example.com', '#section', '//other.example/file', 'javascript:alert(1)', 'data:text/html,boom', 'file://remotehost/share/a.md', 'bad%ZZ']) assert.equal(fileLink(link, 'agent'), undefined);
  assert.equal(fileLink('file.txt'), undefined);
  const html = renderToStaticMarkup(React.createElement(FileLinkContext.Provider, { value: 'agent' }, React.createElement(RichText, { text: '[local](file:///home/user/a.md) [relative](notes/a.md) [external](https://example.com) [bad](javascript:alert)' })));
  assert.match(html, /href="\/api\/files\?agentId=agent&amp;path=/); assert.match(html, /href="https:\/\/example.com"/); assert.ok(!html.includes('href="javascript:'));
});

test('authenticated local files resolve against agent workspace, confine symlinks and render untrusted source inertly', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pi-hub-files-')), root = path.join(temp, 'projects'), workspace = path.join(root, 'work');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'a b.html'), '<script>fetch("/api/me")</script>\n<h1 onclick="evil()">Hello</h1>');
  await writeFile(path.join(workspace, 'report.pdf'), '%PDF-1.4\nfixture');
  await writeFile(path.join(temp, 'secret.txt'), 'outside'); await symlink(path.join(temp, 'secret.txt'), path.join(workspace, 'escape.txt'));
  const config = createConfig('test-password-long', root); config.port = 0; const hub = createHub(config); const agent = emptyAgent('agent'); agent.cwd = workspace; hub.agents.set(agent.id, agent);
  hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening'); config.port = (hub.server.address() as any).port; const base = `http://127.0.0.1:${config.port}`;
  const route = (file: string, extra = '') => base + '/api/files?' + new URLSearchParams({ agentId: agent.id, path: file }) + extra;
  try {
    assert.equal((await fetch(route('a b.html'))).status, 401);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base }, body: JSON.stringify({ password: 'test-password-long' }) }); const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const get = (file: string, extra = '') => fetch(route(file, extra), { headers: { Cookie: cookie } });
    const preview = await get('a b.html'), source = await preview.text(); assert.equal(preview.status, 200); assert.match(source, /&lt;script&gt;/); assert.ok(!source.includes('<script>')); assert.match(source, /id="L2"/); assert.match(source, /agentId=agent/); assert.match(preview.headers.get('content-security-policy')!, /default-src 'none'/); assert.equal(preview.headers.get('cache-control'), 'no-store');
    const absolute = await get(path.join(workspace, 'a b.html')); assert.equal(absolute.status, 200);
    const download = await get('a b.html', '&download=1'); assert.match(download.headers.get('content-disposition')!, /attachment/); assert.match(download.headers.get('content-type')!, /octet-stream/); assert.equal(await download.text(), '<script>fetch("/api/me")</script>\n<h1 onclick="evil()">Hello</h1>');
    const pdf = await get('report.pdf'); assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.match(pdf.headers.get('content-disposition')!, /inline/);
    for (const file of ['../../secret.txt', 'escape.txt', '/etc/passwd', '.', 'missing.txt']) assert.equal((await get(file)).status, 400);
    assert.equal((await fetch(base + '/api/files?agentId=missing&path=file', { headers: { Cookie: cookie } })).status, 404);
    await writeFile(path.join(workspace, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1)); assert.match((await get('large.txt')).headers.get('content-disposition')!, /attachment/); assert.equal((await get('large.txt', '&download=1')).status, 200);
  } finally { await hub.close(); await rm(temp, { recursive: true, force: true }); }
});
