import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const remoteScript = readFileSync(new URL('./tunnel-remote.sh', import.meta.url), 'utf8');
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export interface TunnelOptions {
  host: string;
  localPort: number;
  remotePort?: number;
  heartbeatMs?: number;
  timeoutMs?: number;
  retryMs?: number;
  killMs?: number;
  // Dependency injection keeps tests off the network and away from live sessions.
  spawnSsh?: (args: string[]) => ChildProcess;
  isLocalHealthy?: () => Promise<boolean>;
  log?: (message: string) => void;
}

export function sshArguments(host: string, localPort: number, remotePort: number, timeoutMs: number) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(host)) throw new Error('Invalid SSH host/alias');
  for (const port of [localPort, remotePort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid tunnel port');
  }
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
    // The remote watchdog must never terminate a shared SSH master connection.
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-o', 'StdinNull=no',
    '-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`, host,
    `exec bash -c ${shellQuote(remoteScript)} -- ${remotePort} ${Math.ceil(timeoutMs / 1000)}`];
}

export function startTunnel(options: TunnelOptions) {
  const { host, localPort, remotePort = localPort, heartbeatMs = 10_000, timeoutMs = 45_000,
    retryMs = 5_000, killMs = 2_000, log = console.error } = options;
  const args = sshArguments(host, localPort, remotePort, timeoutMs);
  const spawnSsh = options.spawnSsh ?? (args => spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] }));
  const isLocalHealthy = options.isLocalHealthy ?? (async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/api/auth/status`, { signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      return response.status === 200;
    } catch { return false; }
  });
  type Attempt = {
    child: ChildProcess; lastReply: number; lastPing: number; sequence: number;
    pending: number | undefined; buffer: string; failures: number; closing: boolean;
    killTimer?: ReturnType<typeof setTimeout>;
  };
  let active: Attempt | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let stopResolve: (() => void) | undefined;
  let stopPromise: Promise<void> | undefined;

  function disconnect(attempt: Attempt, reason: string) {
    if (active !== attempt || attempt.closing) return;
    attempt.closing = true;
    log(`Tunnel reconnect: ${reason}`);
    attempt.child.kill('SIGTERM');
    // A frozen SSH process cannot act on SIGTERM. Never wait indefinitely for it.
    attempt.killTimer = setTimeout(() => attempt.child.kill('SIGKILL'), killMs);
  }
  function retry() {
    if (!stopped) retryTimer = setTimeout(connect, retryMs);
    else stopResolve?.();
  }
  async function reply(attempt: Attempt, line: string) {
    const match = /^pong (\d+) (\d{3})$/.exec(line);
    if (!match || Number(match[1]) !== attempt.pending || active !== attempt || attempt.closing) return;
    attempt.pending = undefined;
    attempt.lastReply = Date.now();
    if (match[2] === '200') {
      if (attempt.sequence === 1 || attempt.failures) log('Tunnel healthy (forwarded Hub HTTP check passed)');
      attempt.failures = 0;
    } else {
      // A stopped/unhealthy Hub is not a tunnel fault; do not restart its agents.
      const healthy = await isLocalHealthy();
      if (active !== attempt || attempt.closing) return;
      if (!healthy) { attempt.failures = 0; return; }
      if (++attempt.failures >= 2) disconnect(attempt, 'forwarded HTTP checks failed while local Hub is healthy');
    }
  }
  function tick() {
    const attempt = active;
    if (!attempt || attempt.closing) return;
    const now = Date.now();
    if (now - attempt.lastReply >= timeoutMs) return disconnect(attempt, 'heartbeat timed out (network changed or SSH stalled)');
    if (attempt.pending !== undefined || now - attempt.lastPing < heartbeatMs) return;
    attempt.lastPing = now;
    attempt.pending = ++attempt.sequence;
    attempt.child.stdin?.write(`ping ${attempt.sequence}\n`);
  }
  function connect() {
    retryTimer = undefined;
    if (stopped) return;
    let child: ChildProcess;
    try { child = spawnSsh(args); }
    catch (error) { log(`Cannot start SSH: ${String(error)}`); retry(); return; }
    const attempt: Attempt = { child, lastReply: Date.now(), lastPing: 0, sequence: 0,
      pending: undefined, buffer: '', failures: 0, closing: false };
    active = attempt;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => {
      attempt.buffer += data;
      if (attempt.buffer.length > 16_384) return disconnect(attempt, 'unexpected SSH output');
      let newline: number;
      while ((newline = attempt.buffer.indexOf('\n')) !== -1) {
        const line = attempt.buffer.slice(0, newline).trim();
        attempt.buffer = attempt.buffer.slice(newline + 1);
        void reply(attempt, line);
      }
    });
    child.stderr?.on('data', data => log(String(data).trimEnd()));
    child.stdin?.on('error', () => disconnect(attempt, 'SSH input closed'));
    child.on('error', error => log(`SSH error: ${error.message}`));
    child.on('close', (code, signal) => {
      clearTimeout(attempt.killTimer);
      if (active !== attempt) return;
      active = undefined;
      if (!stopped) log(`SSH closed (${signal || code}); retrying in ${retryMs / 1000}s`);
      retry();
    });
    tick();
  }
  const timer = setInterval(tick, Math.min(1000, heartbeatMs));
  connect();
  return {
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopped = true;
      clearInterval(timer);
      clearTimeout(retryTimer);
      stopPromise = new Promise(resolve => { stopResolve = resolve; });
      if (active) disconnect(active, 'supervisor stopping');
      else stopResolve?.();
      return stopPromise;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , host, localPort, remotePort = localPort] = process.argv;
  if (!host || !localPort) throw new Error('Usage: tunnel.ts SSH_HOST LOCAL_PORT [REMOTE_PORT]');
  const tunnel = startTunnel({ host, localPort: Number(localPort), remotePort: Number(remotePort) });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void tunnel.stop().then(() => process.exit(0)); });
  }
}
