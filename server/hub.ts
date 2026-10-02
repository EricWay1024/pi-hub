import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { applyEvent, emptyAgent, type AgentState, type RecordData } from '../shared/state.js';
import { checkPassword, equalSecret, type Config } from './config.js';
import { historyPage, messageKey, MESSAGE_PAGE_SIZE, visibleMessages } from '../shared/history.js';
import { savedHistoryPage } from './history.js';
import { sameAttachedSession } from '../shared/agent-identity.js';
import { hashRecovery, newEnrollment, recoveryCodes, SESSION_LIFETIME, validTotpStep, verifySecondFactor } from './two-factor.js';
import { hostname } from 'node:os';
import { newTrustedBrowser, trustedBrowser, trustedBrowsers, TRUST_LIFETIME } from './trusted-browsers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxBytes = 16 * 1024 * 1024;
const mime: Record<string,string> = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json', '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf' };
export async function allowedDirectory(base: string, requested: string) {
  const b = await realpath(base), p = await realpath(requested);
  if (p !== b && !p.startsWith(b + path.sep)) throw new Error('Project must be inside projectsRoot');
  if (!(await stat(p)).isDirectory()) throw new Error('Not a directory');
  return p;
}
function send(ws: WebSocket, data: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > maxBytes * 2) { ws.terminate(); return; }
  ws.send(JSON.stringify(data));
}
export function createHub(config: Config, options: { persistConfig?: (config: Config) => void } = {}) {
  const agents = new Map<string, AgentState>();
  const connectors = new Map<string, WebSocket>();
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  const browsers = new Set<WebSocket>();
  const sessions = new Map<string, number>();
  const browserSessions = new Map<WebSocket, string>();
  const pending = new Map<string, { agentId: string; resolve: (r: RecordData) => void; timer: NodeJS.Timeout }>();
  let closing = false;
  const loginAttempts = new Map<string, number[]>();
  let totpAttempts: number[] = [], authRequests: number[] = [];
  function factorThrottled() {
    totpAttempts = totpAttempts.filter(t => t > Date.now() - 5 * 60_000);
    if (totpAttempts.length >= 8) return true;
    totpAttempts.push(Date.now()); return false;
  }
  const enrollments = new Map<string, { secret: string; expires: number; client: string }>();
  const clientKey = (req: http.IncomingMessage) => {
    const forwarded = req.headers['x-real-ip'];
    return config.origin?.startsWith('https:') && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '') && typeof forwarded === 'string' && forwarded.length <= 100 ? forwarded : req.socket.remoteAddress || 'unknown';
  };
  function throttled(req: http.IncomingMessage) {
    authRequests = authRequests.filter(t => t > Date.now() - 60_000);
    if (authRequests.length >= 60) return true;
    const key = clientKey(req), recent = (loginAttempts.get(key) || []).filter(t => t > Date.now() - 60_000);
    if (recent.length >= 8) return true;
    recent.push(Date.now()); loginAttempts.set(key, recent); authRequests.push(Date.now());
    if (loginAttempts.size > 1000) loginAttempts.delete(loginAttempts.keys().next().value!);
    return false;
  }
  function saveTrusted(records: NonNullable<Config['trustedBrowsers']>) {
    options.persistConfig?.({ ...config, trustedBrowsers: records }); config.trustedBrowsers = records;
  }
  function issueSession(res: http.ServerResponse, req?: http.IncomingMessage, trust = false) {
    let id: string, lifetime = SESSION_LIFETIME;
    if (trust) {
      const candidate = newTrustedBrowser(config, req?.headers['user-agent'] || '');
      saveTrusted(candidate.records); id = candidate.token; lifetime = TRUST_LIFETIME;
    } else { id = randomBytes(32).toString('hex'); sessions.set(id, Date.now() + lifetime); }
    res.setHeader('Set-Cookie', `pi_hub=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime / 1000}${config.origin?.startsWith('https:') ? '; Secure' : ''}`);
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBytes });
  const agentWss = new WebSocketServer({ noServer: true, maxPayload: maxBytes });
  const sessionId = (req: http.IncomingMessage) => /(?:^|;\s*)pi_hub=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1] || '';
  const sessionExpiry = (id: string) => sessions.get(id) || trustedBrowser(config, id)?.expires || 0;
  const authenticated = (req: http.IncomingMessage) => sessionExpiry(sessionId(req)) > Date.now();
  const originAllowed = (req: http.IncomingMessage) => {
    const expected = config.origin || `http://127.0.0.1:${config.port}`;
    return req.headers.origin === expected;
  };
  const browserAgent = (state: AgentState) => {
    const messages = visibleMessages(state.messages);
    return { ...state, messages: messages.slice(-MESSAGE_PAGE_SIZE), hasEarlierMessages: messages.length > MESSAGE_PAGE_SIZE || (state.totalMessageCount ?? 0) > state.messages.length };
  };
  const list = () => [...agents.values()].map(state => {
    const { messages, partial, tools, activity, dialogs, ...metadata } = browserAgent(state); return metadata;
  });
  const broadcast = (data: unknown) => { for (const ws of browsers) send(ws, data); };
  let dirty = new Set<string>();
  const replacements: Record<string, string> = {};
  function pruneOfflineDuplicates(current: AgentState) {
    if (!current.online || current.managed) return;
    for (const old of agents.values()) {
      if (old.id === current.id || old.online || !sameAttachedSession(old, current)) continue;
      agents.delete(old.id); dirty.delete(old.id);
      for (const from of Object.keys(replacements)) if (replacements[from] === old.id) replacements[from] = current.id;
      replacements[old.id] = current.id;
      dirty.add(current.id);
    }
  }
  // Coalesce streaming snapshots to avoid quadratic traffic on each token.
  const flush = setInterval(() => {
    for (const id of dirty) { const state = agents.get(id); if (state) broadcast({ type: 'agent', agent: browserAgent(state) }); }
    if (dirty.size) broadcast({ type: 'agents', agents: list(), replacements: { ...replacements } });
    dirty.clear();
    for (const id of Object.keys(replacements)) delete replacements[id];
  }, 120);
  function record(id: string, event: RecordData) {
    const p = event.type === 'response' && pending.get(event.id);
    if (p && p.agentId === id) { clearTimeout(p.timer); pending.delete(event.id); p.resolve(event); return; }
    const state = agents.get(id);
    if (state && event.type !== 'response') { applyEvent(state, event); dirty.add(id); }
  }
  function request(id: string, command: RecordData): Promise<RecordData> {
    const child = children.get(id), ws = connectors.get(id);
    if (!agents.get(id)?.online || (!child && !ws)) return Promise.reject(new Error('Agent is offline'));
    const requestId = randomUUID(), wasBusy = agents.get(id)!.busy;
    const existingMessages = new Set(agents.get(id)!.messages.map(messageKey));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Command timed out; it may still be running. Do not blindly resend.')); }, 30_000);
      pending.set(requestId, { agentId: id, timer, resolve: result => {
        const state = agents.get(id);
        if (result.success && state && !state.managed && !state.queue?.tracked && wasBusy && ['prompt','steer','follow_up'].includes(command.type) && typeof command.message === 'string' && !command.message.startsWith('/')) {
          const delivered = state.messages.some(m => m.role === 'user' && !existingMessages.has(messageKey(m)) && (typeof m.content === 'string' ? m.content : m.content?.filter((b: RecordData) => b.type === 'text').map((b: RecordData) => b.text).join('\n')) === command.message);
          if (!delivered) {
            state.queue ||= { steering: [], followUp: [], estimated: true, tracked: false };
            const mode = command.type === 'follow_up' || command.streamingBehavior === 'followUp' ? 'followUp' : 'steering';
            state.queue[mode].push(command.message); dirty.add(id);
          }
        }
        resolve(result);
      } });
      const record = { ...command, id: requestId };
      if (child) {
        child.stdin.write(JSON.stringify(record) + '\n', error => {
          if (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
        });
      } else send(ws!, { type: 'command', command: record });
    });
  }
  async function launch(cwd: string, name: string) {
    if (children.size >= 12) throw new Error('Maximum 12 managed agents');
    const directory = await allowedDirectory(config.projectsRoot, cwd);
    const id = randomUUID(), state = emptyAgent(id);
    Object.assign(state, { cwd: directory, name: name.slice(0, 100) || path.basename(directory), managed: true, host: hostname() });
    agents.set(id, state);
    const child = spawn(process.env.PI_HUB_PI_BIN || 'pi', ['--mode', 'rpc', '--name', state.name, '-e', path.join(root, 'extensions/hub.ts')], {
      cwd: directory, env: { ...process.env, PI_HUB_OBSERVER_ID: id, PI_WEB_UI_DISABLED: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.set(id, child);
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > maxBytes) { child.kill('SIGTERM'); record(id, { type: 'diagnostic', text: 'RPC record exceeded limit' }); buffer = ''; return; }
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        try { record(id, JSON.parse(line)); } catch { record(id, { type: 'diagnostic', text: 'Invalid RPC JSON record' }); }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => record(id, { type: 'diagnostic', text: text.slice(-4000) }));
    const offline = () => { children.delete(id); state.online = false; state.busy = false; dirty.add(id); };
    child.on('error', error => { record(id, { type: 'diagnostic', text: error.message }); offline(); });
    child.on('exit', (code, signal) => { record(id, { type: 'diagnostic', text: `Pi exited (${code ?? signal})` }); offline(); });
    dirty.add(id);
    // State is requested through RPC, without model calls.
    request(id, { type: 'get_state' }).then(r => {
      if (r.success) { state.model = r.data?.model?.id; state.thinking = r.data?.thinkingLevel; state.sessionFile = r.data?.sessionFile; state.sessionId = r.data?.sessionId; dirty.add(id); }
    }).catch(error => record(id, { type: 'diagnostic', text: error.message }));
    return id;
  }
  const json = (res: http.ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  async function body(req: http.IncomingMessage, limit = maxBytes): Promise<RecordData> {
    let data = ''; for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > limit) throw new Error('Request too large'); }
    const parsed = JSON.parse(data || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected object');
    return parsed;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (config.origin?.startsWith('https:')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'POST' && !originAllowed(req)) return json(res, 403, { error: 'Origin rejected' });
      if (url.pathname === '/api/auth/status' && req.method === 'GET') return json(res, 200, { twoFactorEnabled: !!config.twoFactor });
      if (url.pathname === '/api/login' && req.method === 'POST') {
        if (throttled(req)) return json(res, 429, { error: 'Too many attempts. Wait one minute.' });
        const b = await body(req, 4096);
        const invalidLogin = () => json(res, 401, { error: config.twoFactor ? 'Incorrect password or second factor. Authenticator codes are one-use; wait for a fresh code if already used.' : 'Incorrect password' });
        if (typeof b.password !== 'string' || b.password.length > 1024 || !checkPassword(b.password, config)) return invalidLogin();
        const recovery = typeof b.recoveryCode === 'string' && b.recoveryCode.length <= 100;
        if (config.twoFactor && !recovery && factorThrottled()) return json(res, 429, { error: 'Too many authenticator attempts. Wait five minutes or use a recovery code.' });
        if (!verifySecondFactor(config, b.code, b.recoveryCode)) return invalidLogin();
        if (config.twoFactor) options.persistConfig?.(config);
        if (b.trustBrowser === true && !config.twoFactor) return json(res, 400, { error: 'Enable 2FA before trusting a browser.' });
        issueSession(res, req, b.trustBrowser === true); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/auth/enroll/start' && req.method === 'POST') {
        if (throttled(req)) return json(res, 429, { error: 'Too many attempts. Wait one minute.' });
        if (config.twoFactor) return json(res, 409, { error: 'Two-factor authentication is already enabled.' });
        const b = await body(req, 4096);
        if (!config.enrollmentHash || typeof b.password !== 'string' || b.password.length > 1024 || typeof b.setupToken !== 'string' || b.setupToken.length > 100 || !checkPassword(b.password, config) || !equalSecret(hashRecovery(b.setupToken), config.enrollmentHash)) return json(res, 401, { error: 'Incorrect password or laptop enrollment token.' });
        const candidate = newEnrollment(), challenge = randomBytes(32).toString('hex');
        if (enrollments.size >= 20) enrollments.delete(enrollments.keys().next().value!);
        enrollments.set(challenge, { secret: candidate.secret, expires: Date.now() + 5 * 60_000, client: clientKey(req) });
        return json(res, 200, { challenge, secret: candidate.secret, uri: candidate.uri });
      }
      if (url.pathname === '/api/auth/enroll/finish' && req.method === 'POST') {
        if (throttled(req)) return json(res, 429, { error: 'Too many attempts. Wait one minute.' });
        const b = await body(req, 4096), pending = typeof b.challenge === 'string' ? enrollments.get(b.challenge) : undefined;
        if (config.twoFactor || !pending || pending.expires < Date.now() || pending.client !== clientKey(req)) return json(res, 400, { error: 'Enrollment expired or invalid. Start again.' });
        const step = validTotpStep(pending.secret, b.code);
        if (step === null) return json(res, 401, { error: 'Incorrect authenticator code. Check your phone clock and try a fresh code.' });
        const codes = recoveryCodes();
        const upgraded = { ...config, trustedBrowsers: [], twoFactor: { secret: pending.secret, lastUsedStep: step, recoveryHashes: codes.map(hashRecovery) } };
        delete upgraded.enrollmentHash; options.persistConfig?.(upgraded);
        config.twoFactor = upgraded.twoFactor; config.trustedBrowsers = []; delete config.enrollmentHash;
        enrollments.clear(); sessions.clear();
        issueSession(res);
        setTimeout(() => { for (const ws of browsers) if (sessionExpiry(browserSessions.get(ws) || '') <= Date.now()) ws.close(1008, 'Authentication upgraded'); }, 200).unref();
        return json(res, 200, { ok: true, recoveryCodes: codes });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authenticated(req)) return json(res, 401, { error: 'Sign in required' });
        if (url.pathname === '/api/me') return json(res, 200, { ok: true });
        if (url.pathname === '/api/auth/trusted' && req.method === 'GET') {
          const current = trustedBrowser(config, sessionId(req));
          return json(res, 200, { browsers: trustedBrowsers(config).map(({ id, label, created, expires }) => ({ id, label, created, expires, current: id === current?.id })) });
        }
        if (url.pathname === '/api/auth/trusted/revoke' && req.method === 'POST') {
          const b = await body(req, 4096);
          if (typeof b.id !== 'string' || (b.id !== 'all' && !config.trustedBrowsers?.some(device => device.id === b.id))) return json(res, 400, { error: 'Unknown trusted browser' });
          saveTrusted((config.trustedBrowsers || []).filter(device => b.id !== 'all' && device.id !== b.id));
          setTimeout(() => { for (const [ws, sid] of browserSessions) if (sessionExpiry(sid) <= Date.now()) ws.close(1008, 'Browser trust revoked'); }, 200).unref();
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/logout' && req.method === 'POST') {
          const id = sessionId(req), remembered = trustedBrowser(config, id);
          if (remembered) saveTrusted((config.trustedBrowsers || []).filter(b => b.id !== remembered.id));
          sessions.delete(id);
          for (const [ws, sid] of browserSessions) if (sid === id) ws.close(1008, 'Signed out');
          res.setHeader('Set-Cookie', 'pi_hub=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/projects' && req.method === 'GET') {
          const dirs = await readdir(config.projectsRoot, { withFileTypes: true });
          return json(res, 200, { root: config.projectsRoot, projects: dirs.filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => ({ name: d.name, path: path.join(config.projectsRoot, d.name) })) });
        }
        const historyMatch = /^\/api\/agents\/([^/]+)\/history$/.exec(url.pathname);
        if (historyMatch && req.method === 'GET') {
          const state = agents.get(decodeURIComponent(historyMatch[1]));
          if (!state) return json(res, 404, { error: 'Unknown agent' });
          const before = url.searchParams.get('before') || undefined;
          if (before && before.length > 300) return json(res, 400, { error: 'Invalid history cursor' });
          const sessionFile = state.sessionFile;
          const page = sessionFile ? await savedHistoryPage(sessionFile, before) : historyPage(state.messages, before);
          return json(res, 200, { ...page, sessionFile, sessionId: state.sessionId, limited: !sessionFile });
        }
        if (url.pathname === '/api/agents' && req.method === 'POST') {
          const b = await body(req);
          if (typeof b.cwd !== 'string' || (b.name !== undefined && typeof b.name !== 'string')) return json(res, 400, { error: 'Invalid project/name' });
          return json(res, 201, { id: await launch(b.cwd, b.name || '') });
        }
        return json(res, 404, { error: 'Not found' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      const staticRoot = path.join(root, 'dist');
      const file = path.resolve(staticRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(staticRoot + path.sep)) return json(res, 403, { error: 'Forbidden' });
      try { const data = await readFile(file); res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(data); }
      catch { json(res, 404, { error: 'Not found. Run npm run build first.' }); }
    } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : 'Bad request' }); }
  });
  server.on('upgrade', (req, socket, head) => {
    const route = new URL(req.url || '/', 'http://localhost').pathname;
    if (route === '/agent' && equalSecret(req.headers.authorization || '', `Bearer ${config.agentToken}`)) {
      agentWss.handleUpgrade(req, socket, head, ws => agentWss.emit('connection', ws, req));
    } else if (route === '/ws' && authenticated(req) && originAllowed(req)) {
      wss.handleUpgrade(req, socket, head, ws => { browserSessions.set(ws, sessionId(req)); wss.emit('connection', ws, req); });
    } else { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  agentWss.on('connection', ws => {
    let id: string | undefined, observer = false;
    const registration = setTimeout(() => ws.close(1008, 'Registration required'), 5000);
    ws.on('message', data => {
      if (id && !observer && connectors.get(id) !== ws) return;
      try {
        const r = JSON.parse(data.toString());
        if (r.type === 'register') {
          if (typeof r.id !== 'string' || r.id.length > 200) throw new Error('Invalid ID');
          clearTimeout(registration); id = r.id; observer = r.observer === true;
          if (observer) { if (!children.has(id!)) throw new Error('Unknown managed agent'); return; }
          const previous = connectors.get(id!); connectors.set(id!, ws); previous?.close();
          const state = agents.get(id!) || emptyAgent(id!);
          Object.assign(state, r.metadata, { id, online: true, managed: false });
          agents.set(id!, state); pruneOfflineDuplicates(state); dirty.add(id!);
        } else if (id && r.type === 'snapshot' && !observer) {
          const state = agents.get(id)!;
          Object.assign(state, r.state, { id, online: true, managed: false }); pruneOfflineDuplicates(state); dirty.add(id);
        } else if (id && r.type === 'event') record(id, r.event);
        else if (id && r.type === 'response') record(id, r);
      } catch { ws.close(1008, 'Invalid agent record'); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(registration);
      if (id && connectors.get(id) === ws) {
        connectors.delete(id); const state = agents.get(id);
        if (state) {
          state.online = false; dirty.add(id);
          // The replacement can register before the old socket's close arrives.
          const replacement = [...agents.values()].find(a => a.online && a.id !== id && sameAttachedSession(state, a));
          if (replacement) pruneOfflineDuplicates(replacement);
        }
      }
    });
  });
  wss.on('connection', ws => {
    browsers.add(ws); send(ws, { type: 'agents', agents: list() });
    for (const state of agents.values()) send(ws, { type: 'agent', agent: browserAgent(state) });
    ws.on('message', async data => {
      let r: RecordData = {};
      try {
        if (sessionExpiry(browserSessions.get(ws) || '') <= Date.now()) { ws.close(1008, 'Session expired'); return; }
        const parsed = JSON.parse(data.toString());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected object');
        r = parsed;
        const id = r.agentId;
        if (typeof id !== 'string' || !agents.has(id)) throw new Error('Unknown agent');
        if (r.type === 'stop') {
          const child = children.get(id); if (!child) throw new Error('Only managed agents can be stopped');
          child.stdin.end(); setTimeout(() => { if (children.get(id) === child) child.kill('SIGTERM'); }, 5000).unref();
          send(ws, { type: 'reply', id: r.id, success: true }); return;
        }
        if (r.type !== 'command' || !r.command || typeof r.command !== 'object') throw new Error('Invalid command');
        const allowed = ['prompt', 'steer', 'follow_up', 'abort', 'get_state', 'get_messages', 'get_available_models', 'set_model', 'set_thinking_level', 'set_session_name', 'compact', 'get_commands', 'extension_ui_response'];
        if (!allowed.includes(r.command.type)) throw new Error('Unsupported command');
        if (['prompt','steer','follow_up'].includes(r.command.type) && typeof r.command.message !== 'string') throw new Error('Message required');
        if (r.command.type === 'extension_ui_response') {
          const state = agents.get(id)!;
          if (!state.dialogs[r.command.id]) throw new Error('Unknown dialog');
          const child = children.get(id); if (!child) throw new Error('Terminal dialogs must be answered in terminal');
          child.stdin.write(JSON.stringify(r.command) + '\n'); delete state.dialogs[r.command.id]; dirty.add(id);
          send(ws, { type: 'reply', id: r.id, success: true }); return;
        }
        const result = await request(id, r.command);
        if (result.success) {
          const state = agents.get(id)!;
          if (r.command.type === 'set_session_name') state.name = r.command.name;
          if (r.command.type === 'set_model') state.model = r.command.modelId;
          if (r.command.type === 'set_thinking_level') state.thinking = r.command.level;
          dirty.add(id);
        }
        send(ws, { ...result, type: 'reply', id: r.id });
      } catch (error) { send(ws, { type: 'reply', id: r.id, success: false, error: error instanceof Error ? error.message : 'Command failed' }); }
    });
    ws.on('error', () => {});
    ws.on('close', () => { browsers.delete(ws); browserSessions.delete(ws); });
  });
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of [...wss.clients, ...agentWss.clients]) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws); ws.ping();
    }
    for (const [id, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(id);
    for (const [id, enrollment] of enrollments) if (enrollment.expires <= Date.now()) enrollments.delete(id);
    for (const [key, attempts] of loginAttempts) if (attempts.at(-1)! < Date.now() - 60_000) loginAttempts.delete(key);
    for (const [ws, sid] of browserSessions) if (sessionExpiry(sid) <= Date.now()) ws.close(1008, 'Session expired');
  }, 30_000);
  for (const group of [wss, agentWss]) group.on('connection', ws => { alive.add(ws); ws.on('pong', () => alive.add(ws)); });
  return { server, agents, async close() {
    if (closing) return; closing = true;
    clearInterval(flush); clearInterval(heartbeat);
    for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ type: 'response', success: false, error: 'Hub shutting down' }); } pending.clear();
    for (const ws of [...wss.clients, ...agentWss.clients]) ws.terminate();
    for (const child of children.values()) { child.stdin.end(); child.kill('SIGTERM'); }
    wss.close(); agentWss.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
