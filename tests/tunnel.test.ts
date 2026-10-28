import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTunnel, sshArguments } from '../deploy/tunnel.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  assert.fail('Timed out waiting for tunnel state');
}
class FakeSsh extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  signals: string[] = [];
  pings: string[] = [];
  ignoreTerm = false;
  status: string | undefined = '200';
  constructor() {
    super();
    this.stdin.on('data', data => {
      const ping = String(data).trim(); this.pings.push(ping);
      if (this.status) queueMicrotask(() => this.stdout.write(`${ping.replace('ping ', 'pong ')} ${this.status}\n`));
    });
  }
  kill(signal: string) {
    this.signals.push(signal);
    if (signal !== 'SIGTERM' || !this.ignoreTerm) queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}
function fixture(first: FakeSsh, localHealthy = true) {
  const children: FakeSsh[] = [], logs: string[] = [];
  const tunnel = startTunnel({ host: 'example', localPort: 7433, heartbeatMs: 15, timeoutMs: 100,
    retryMs: 10, killMs: 20, isLocalHealthy: async () => localHealthy, log: message => logs.push(message),
    spawnSsh: () => {
      const child = children.length ? new FakeSsh() : first;
      children.push(child); return child as unknown as ChildProcess;
    },
  });
  return { tunnel, children, logs };
}

test('tunnel uses loopback-only forwarding and an isolated SSH transport', () => {
  const args = sshArguments('user@example', 7433, 17433, 45_000);
  for (const value of ['BatchMode=yes', 'ControlMaster=no', 'ControlPath=none', 'ControlPersist=no', 'ExitOnForwardFailure=yes']) assert.ok(args.includes(value));
  assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:17433:127.0.0.1:7433');
  assert.match(args.at(-1)!, /^exec bash -c /);
  assert.ok(!args.includes('-N'));
  for (const host of ['-oProxyCommand=bad', 'host;touch bad', 'host\nother']) assert.throws(() => sshArguments(host, 7433, 7433, 45_000));
  for (const port of [0, -1, 65536, NaN, 1.5]) assert.throws(() => sshArguments('example', port, 7433, 45_000));
});

test('shell scripts parse; remote watchdog refuses a non-SSH parent without killing it', () => {
  const remote = new URL('../deploy/tunnel-remote.sh', import.meta.url).pathname;
  execFileSync('bash', ['-n', remote]);
  execFileSync('bash', ['-n', new URL('../deploy/install-local-services.sh', import.meta.url).pathname]);
  assert.throws(() => execFileSync('bash', [remote, '7433', '1'], { stdio: 'pipe' }), /direct child of its own SSH session/);
});

test('tunnel-only installer leaves Hub unit untouched and does not start/restart Hub', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'pi-hub-tunnel-installer-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const units = path.join(home, '.config/systemd/user');
  await mkdir(units, { recursive: true }); await mkdir(path.join(home, 'bin'));
  const config = path.join(home, 'config.json');
  await writeFile(config, JSON.stringify({ port: 17433 }));
  await writeFile(path.join(units, 'pi-hub.service'), '# existing custom Hub unit\n');
  await writeFile(path.join(home, 'bin/systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/systemctl-calls"\n', { mode: 0o700 });
  execFileSync('bash', [new URL('../deploy/install-local-services.sh', import.meta.url).pathname], {
    env: { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}`, PI_HUB_CONFIG: config,
      PI_HUB_TUNNEL_ONLY: '1', PI_HUB_SSH_HOST: 'example' },
  });
  assert.equal(await readFile(path.join(units, 'pi-hub.service'), 'utf8'), '# existing custom Hub unit\n');
  const unit = await readFile(path.join(units, 'pi-hub-tunnel.service'), 'utf8');
  assert.match(unit, /deploy\/tunnel\.ts" "example" 17433/);
  assert.doesNotMatch(unit, /tsx|ssh -NT/);
  assert.equal(await readFile(path.join(home, 'systemctl-calls'), 'utf8'), '--user daemon-reload\n--user enable --now pi-hub-tunnel.service\n');
});

test('healthy heartbeats retain the connection; stop does not reconnect', async t => {
  const first = new FakeSsh(); const f = fixture(first); t.after(() => f.tunnel.stop());
  await until(() => first.pings.length >= 4);
  assert.equal(f.children.length, 1);
  assert.ok(f.logs.some(log => log.includes('Tunnel healthy')));
  await f.tunnel.stop(); await delay(40);
  assert.equal(f.children.length, 1);
  assert.deepEqual(first.signals, ['SIGTERM']);
});

test('silent/frozen SSH is killed and retried without needing TCP to time out', async t => {
  const first = new FakeSsh(); first.status = undefined; first.ignoreTerm = true;
  const f = fixture(first); t.after(() => f.tunnel.stop());
  await until(() => f.children.length === 2);
  assert.deepEqual(first.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(f.logs.some(log => log.includes('heartbeat timed out')));
});

test('wrong or replayed pong identifiers do not mask a dead connection', async t => {
  const first = new FakeSsh(); first.status = undefined;
  const f = fixture(first); t.after(() => f.tunnel.stop());
  const noise = setInterval(() => first.stdout.write('pong 0 200\npong 999 200\n'), 10);
  t.after(() => clearInterval(noise));
  await until(() => f.children.length === 2);
  assert.ok(f.logs.some(log => log.includes('heartbeat timed out')));
});

test('failed forwarded HTTP probes reconnect only when local Hub is healthy', async t => {
  const first = new FakeSsh(); first.status = '000';
  const f = fixture(first); t.after(() => f.tunnel.stop());
  await until(() => f.children.length === 2);
  assert.equal(first.pings.length, 2);
  assert.ok(f.logs.some(log => log.includes('local Hub is healthy')));
});

test('a backend outage does not churn the tunnel or restart Hub', async t => {
  const first = new FakeSsh(); first.status = '503';
  const f = fixture(first, false); t.after(() => f.tunnel.stop());
  await until(() => first.pings.length >= 10);
  assert.equal(f.children.length, 1);
  assert.deepEqual(first.signals, []);
});

test('SSH exits (including port conflicts) retry without killing unrelated remote processes', async t => {
  const first = new FakeSsh(); const f = fixture(first); t.after(() => f.tunnel.stop());
  first.emit('close', 255, null);
  await until(() => f.children.length === 2);
  assert.deepEqual(first.signals, []);
  assert.ok(f.logs.some(log => log.includes('SSH closed (255)')));
});
