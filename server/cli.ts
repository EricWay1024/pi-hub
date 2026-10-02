import { createInterface } from 'node:readline/promises';
import { rmSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { checkPassword, configPath, createConfig, ensureEnrollmentToken, enrollmentTokenPath, loadConfig, replaceConfig, saveConfig } from './config.js';
import { hashRecovery } from './two-factor.js';
import { createHub } from './hub.js';

async function readPassword(prompt = 'Choose hub password (input hidden): '): Promise<string> {
  if (process.env.PI_HUB_PASSWORD) return process.env.PI_HUB_PASSWORD;
  if (!stdin.isTTY) throw new Error('Set PI_HUB_PASSWORD for noninteractive setup');
  stdout.write(prompt);
  stdin.setRawMode(true); stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const listener = (buffer: Buffer) => {
      for (const char of buffer.toString()) {
        if (char === '\u0003') { cleanup(); reject(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1); else value += char;
      }
    };
    function cleanup() { stdin.off('data', listener); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); }
    stdin.on('data', listener);
  });
}
const action = process.argv[2];
if (action === 'setup') {
  const password = await readPassword();
  const rl = createInterface({ input: stdin, output: stdout });
  const root = process.env.PI_HUB_PROJECTS_ROOT || await rl.question(`Projects root [${process.env.HOME}/projects]: `) || `${process.env.HOME}/projects`;
  rl.close();
  const config = createConfig(password, root);
  if (process.env.PI_HUB_ORIGIN) config.origin = process.env.PI_HUB_ORIGIN;
  saveConfig(config);
  console.log(`Created ${configPath()}. Run npm run build && npm start.`);
} else if (action === 'password') {
  const old = loadConfig(), next = createConfig(await readPassword(), old.projectsRoot);
  const updated = { ...old, trustedBrowsers: [], passwordSalt: next.passwordSalt, passwordHash: next.passwordHash };
  replaceConfig(updated);
  console.log('Password changed. Restart pi-hub to revoke existing logins and apply it.');
} else if (action === 'reset-2fa') {
  const config = loadConfig();
  if (!checkPassword(await readPassword('Enter current workspace password (input hidden): '), config)) throw new Error('Incorrect workspace password');
  delete config.twoFactor; delete config.enrollmentHash; config.trustedBrowsers = [];
  ensureEnrollmentToken(config, hashRecovery);
  console.log(`2FA reset locally. Re-enroll using ${enrollmentTokenPath()} and restart pi-hub to revoke sessions.`);
} else {
  let config;
  try { config = loadConfig(); } catch { throw new Error(`Run npm run setup first (${configPath()})`); }
  ensureEnrollmentToken(config, hashRecovery);
  const hub = createHub(config, { persistConfig: updated => {
    const disk = loadConfig();
    if (disk.passwordHash !== config.passwordHash || disk.twoFactor?.secret !== config.twoFactor?.secret || disk.enrollmentHash !== config.enrollmentHash) throw new Error('Authentication configuration changed locally. Restart pi-hub before saving changes.');
    replaceConfig(updated); if (updated.twoFactor) { try { rmSync(enrollmentTokenPath(), { force: true }); } catch { console.warn('Could not remove the obsolete 2FA enrollment-token file; remove it locally.'); } } } });
  hub.server.listen(config.port, '127.0.0.1', () => console.log(`Pi Hub: ${config.origin || `http://127.0.0.1:${config.port}`} (loopback-only)`));
  hub.server.on('error', error => { console.error(error.message); void hub.close().then(() => process.exit(1)); });
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => void hub.close().then(() => process.exit()));
}
