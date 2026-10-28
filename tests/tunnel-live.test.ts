// Opt-in SSH fault tests. Use an UNUSED remote loopback port, never production 7433.
// PI_HUB_TUNNEL_TEST_HOST=truss PI_HUB_TUNNEL_TEST_PORT=17433 node --import tsx --test tests/tunnel-live.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { sshArguments, startTunnel } from '../deploy/tunnel.js';

const host = process.env.PI_HUB_TUNNEL_TEST_HOST;
const remotePort = Number(process.env.PI_HUB_TUNNEL_TEST_PORT || 17433);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await delay(100); }
  assert.fail('Live tunnel recovery timed out');
}

test('live SSH: remote lease expiry and frozen-client recovery', { skip: !host, timeout: 60_000 }, async t => {
  assert.notEqual(remotePort, 7433, 'Never fault-test the production tunnel');
  const server = createServer((_req, res) => { res.writeHead(200); res.end('{"test":true}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const localPort = (server.address() as { port: number }).port;
  const args = sshArguments(host!, localPort, remotePort, 6000);
  const first = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (first.exitCode === null && !first.signalCode) first.kill('SIGKILL'); });
  let output = '', errors = '', closed = false;
  first.stdout.on('data', chunk => { output += chunk; });
  first.stderr.on('data', chunk => { errors += chunk; });
  first.on('close', () => { closed = true; });
  first.stdin.on('error', () => {});
  first.stdin.write('ping 1\n');
  await until(() => output.includes('pong 1 200') || closed);
  assert.ok(output.includes('pong 1 200'), errors);
  // A contender must fail closed, not kill the existing port owner.
  const contender = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (contender.exitCode === null && !contender.signalCode) contender.kill('SIGKILL'); });
  const [conflictCode] = await once(contender, 'close');
  assert.equal(conflictCode, 255);
  assert.equal(closed, false, 'A port conflict must not terminate the existing session');
  // TCP/SSH remains connected, but no further application heartbeats are sent.
  // The VPS must release the port on its own, not wait for SSH/TCP keepalives.
  await until(() => closed, 12_000);

  const children: ChildProcess[] = [], logs: string[] = [];
  const tunnel = startTunnel({ host: host!, localPort, remotePort, heartbeatMs: 1000,
    timeoutMs: 10_000, retryMs: 1000, killMs: 1000, log: line => { logs.push(line); console.log(line); },
    spawnSsh: argv => {
      const child = spawn('ssh', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child); return child;
    },
  });
  t.after(() => tunnel.stop());
  await until(() => logs.filter(line => line.includes('Tunnel healthy')).length >= 1);
  assert.equal(children.length, 1, 'Previous remote watchdog must have released its own port');
  assert.ok(children[0].kill('SIGSTOP'));
  await until(() => logs.filter(line => line.includes('Tunnel healthy')).length >= 2);
  assert.ok(children.length >= 2, 'Supervisor must replace the frozen SSH client');
  assert.ok(logs.some(line => line.includes('heartbeat timed out')));
  await delay(2500);
  assert.equal(children.length, 2, 'Recovered tunnel remains healthy');
  await tunnel.stop();
});
