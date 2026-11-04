#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dryRun = process.argv.includes('--dry-run');
if (process.platform !== 'darwin' && !dryRun) throw new Error('This installer requires macOS');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = homedir(), node = process.env.PI_HUB_NODE_BIN || process.execPath;
if (!path.isAbsolute(node) || !existsSync(node)) throw new Error('PI_HUB_NODE_BIN must name an existing absolute executable');
const configFile = path.resolve(process.env.PI_HUB_CONFIG || path.join(home, '.config/pi-hub/config.json'));
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const validPort = p => Number.isInteger(p) && p >= 1 && p <= 65535;
if (!validPort(config.port)) throw new Error('Invalid configured hub port');
if (!existsSync(path.join(root, 'dist/index.html'))) throw new Error('Run npm run build first');
const host = process.env.PI_HUB_SSH_HOST;
const remotePort = Number(process.env.PI_HUB_REMOTE_PORT || config.port);
if (host && (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(host) || !validPort(remotePort))) throw new Error('Invalid SSH host or remote port');
const pi = process.env.PI_HUB_PI_BIN || path.join(root, 'node_modules/.bin/pi');
if (!existsSync(pi)) throw new Error('Install Pi or set PI_HUB_PI_BIN to its executable');
const directory = path.resolve(process.env.PI_HUB_LAUNCH_AGENTS_DIR || path.join(home, 'Library/LaunchAgents'));
const logs = path.join(home, 'Library/Logs/pi-hub');
mkdirSync(directory, { recursive: true, mode: 0o700 }); mkdirSync(logs, { recursive: true, mode: 0o700 });
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const string = value => `<string>${escape(value)}</string>`;
const env = { HOME: home, PATH: [path.dirname(node), path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), PI_HUB_CONFIG: configFile, PI_HUB_PI_BIN: pi };
const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const codex = process.env.PI_HUB_CODEX_BIN || (existsSync(bundledCodex) ? bundledCodex : undefined);
if (codex) {
  if (!path.isAbsolute(codex) || !existsSync(codex)) throw new Error('PI_HUB_CODEX_BIN must name an existing absolute executable');
  env.PI_HUB_CODEX_BIN = codex;
}
function install(label, args, restart) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${args.map(string).join('')}</array>
<key>WorkingDirectory</key>${string(root)}
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${escape(k)}</key>${string(v)}`).join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key>${restart ? '<true/>' : '<dict><key>SuccessfulExit</key><false/></dict>'}
<key>ThrottleInterval</key><integer>5</integer>
<key>ExitTimeOut</key><integer>15</integer>
<key>StandardOutPath</key>${string(path.join(logs, label + '.log'))}
<key>StandardErrorPath</key>${string(path.join(logs, label + '.error.log'))}
</dict></plist>\n`;
  const file = path.join(directory, label + '.plist');
  writeFileSync(file, plist, { mode: 0o600 });
  if (dryRun) { console.log(`Generated ${file} (not loaded)`); return; }
  execFileSync('/usr/bin/plutil', ['-lint', file], { stdio: 'inherit' });
  const domain = `gui/${process.getuid()}`;
  let loaded = false;
  try { execFileSync('/bin/launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' }); loaded = true; } catch {}
  // A service restart stops managed agents. Installation never restarts a loaded job.
  if (loaded) console.log(`${label} is already loaded; its running job was left in place.`);
  else execFileSync('/bin/launchctl', ['bootstrap', domain, file], { stdio: 'inherit' });
}
install('je.yw.pi-hub', [node, path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'server/cli.ts')], false);
if (host) install('je.yw.pi-hub-tunnel', [node, path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'deploy/tunnel.ts'), host, String(config.port), String(remotePort)], true);
console.log('LaunchAgents start at login. Logs: ' + logs);
console.log('The Mac must be awake and connected for remote access.');
