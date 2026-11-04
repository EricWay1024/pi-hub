import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('macOS installer writes valid private plists with distinct tunnel ports, escaped paths and no credentials', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'pi hub & mac-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = path.join(home, 'private-config.json'), directory = path.join(home, 'agents');
  await writeFile(config, JSON.stringify({ port: 7433, agentToken: 'private-token-must-not-appear', passwordHash: 'private-hash-must-not-appear' }));
  const installer = fileURLToPath(new URL('../deploy/install-macos-services.mjs', import.meta.url));
  const env = { ...process.env, HOME: home, PI_HUB_CONFIG: config, PI_HUB_LAUNCH_AGENTS_DIR: directory, PI_HUB_SSH_HOST: 'owner@example', PI_HUB_REMOTE_PORT: '7434', PI_HUB_CODEX_BIN: process.execPath };
  execFileSync(process.execPath, [installer, '--dry-run'], { env });
  for (const label of ['je.yw.pi-hub', 'je.yw.pi-hub-tunnel']) {
    const file = path.join(directory, label + '.plist'), text = await readFile(file, 'utf8');
    assert.ok(text.includes('pi hub &amp; mac-'));
    assert.match(text, /<key>PI_HUB_CODEX_BIN<\/key>/);
    assert.doesNotMatch(text, /private-token-must-not-appear|private-hash-must-not-appear/);
    if (label.endsWith('tunnel')) assert.match(text, /<string>owner@example<\/string><string>7433<\/string><string>7434<\/string>/);
    if (process.platform === 'darwin') execFileSync('/usr/bin/plutil', ['-lint', file]);
  }
  assert.throws(() => execFileSync(process.execPath, [installer, '--dry-run'], { env: { ...env, PI_HUB_REMOTE_PORT: '65536' }, stdio: 'pipe' }), /Invalid SSH host or remote port/);
});
