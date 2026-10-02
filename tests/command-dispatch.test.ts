import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

test('real Pi extension API discovers and dispatches slash commands without calling a model', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'pi-hub-command-api-'));
  const captured: { api?: ExtensionAPI } = {};
  let invoked: (args: string) => void;
  const dispatched = new Promise<string>(resolve => { invoked = resolve; });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      captured.api = pi;
      pi.registerCommand('hub-test-command', { description: 'Test command', handler: async args => { invoked(args); } });
    }],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: temp, agentDir: temp, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory() }));
    await session.bindExtensions({ mode: 'print' });
    let modelRuns = 0; session.subscribe(event => { if (event.type === 'agent_start') modelRuns++; });
    assert.ok(captured.api);
    assert.ok(captured.api.getCommands().some(c => c.name === 'hub-test-command'));
    captured.api.sendUserMessage([{ type: 'text', text: '/hub-test-command actual arguments' }], { expandPromptTemplates: true });
    const args = await Promise.race([dispatched, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Command dispatch timed out')), 3000); })]);
    assert.equal(args, 'actual arguments'); assert.equal(modelRuns, 0);
  } finally { clearTimeout(timer); session?.dispose(); await rm(temp, { recursive: true }); }
});
