import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RichText } from './RichText';
import { Transcript } from './Transcript';
import { ToolActivity, ActivityFeed } from './Activity';
import { MessageQueue } from './MessageQueue';
import { SecuritySettings } from './SecuritySettings';
import type { AgentState, RecordData } from '../shared/state';
import { mergeMessages, messageKey, MESSAGE_PAGE_SIZE, visibleMessages } from '../shared/history';
import { commandList, parseSlashCommand, type SlashCommand } from '../shared/commands';
import { SlashComposer } from './SlashComposer';

type HistoryView = { messages: RecordData[]; hasMore: boolean; limited: boolean; session: string };
const historySession = (agent?: AgentState) => `${agent?.sessionId || ''}:${agent?.sessionFile || ''}`;
import 'katex/dist/katex.min.css';
import './style.css';
import './output.css';
import './sidebar.css';
import './compact.css';

async function api(route: string, data?: unknown) {
  const res = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  const result = await res.json(); if (!res.ok) throw Object.assign(new Error(result.error || 'Request failed'), { status: res.status }); return result;
}
function Dialog({ dialog, respond }: { dialog: RecordData; respond: (r: RecordData) => void }) {
  const [value, setValue] = useState(dialog.prefill || '');
  return <section className="dialog"><div className="eyebrow">Agent needs your input</div><h3>{dialog.title}</h3><p>{dialog.message}</p>
    {dialog.method === 'select' ? <div className="row wrap">{dialog.options.map((v: string) => <button key={v} onClick={() => respond({ value: v })}>{v}</button>)}</div> : dialog.method === 'confirm' ? <div className="row"><button onClick={() => respond({ confirmed: true })}>Allow</button><button onClick={() => respond({ confirmed: false })}>Deny</button></div> : <><textarea aria-label={dialog.title} placeholder={dialog.placeholder} value={value} onChange={e => setValue(e.target.value)}/><button onClick={() => respond({ value })}>Reply</button></>}
    <button className="subtle" onClick={() => respond({ cancelled: true })}>Dismiss</button>
  </section>;
}
function App() {
  const [authed, setAuthed] = useState(false), [checking, setChecking] = useState(true), [password, setPassword] = useState('');
  const [error, setError] = useState(''), [connected, setConnected] = useState(false);
  const [trustBrowser, setTrustBrowser] = useState(false);
  const [twoFactor, setTwoFactor] = useState(false), [loginCode, setLoginCode] = useState(''), [useRecovery, setUseRecovery] = useState(false), [security, setSecurity] = useState(false);
  const [agents, setAgents] = useState<Record<string, AgentState>>({}), [selected, setSelected] = useState('');
  const [draft, setDraft] = useState(''), [sending, setSending] = useState(false), [behavior, setBehavior] = useState('steer');
  const [images, setImages] = useState<RecordData[]>([]), [attachments, setAttachments] = useState<string[]>([]);
  const [projects, setProjects] = useState<RecordData[]>([]), [launching, setLaunching] = useState(false), [project, setProject] = useState('');
  const [panel, setPanel] = useState(false), [mobileList, setMobileList] = useState(false), [models, setModels] = useState<RecordData[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('pi-hub.sidebar-collapsed') === 'true'; } catch { return false; }
  });
  const mobileSidebarToggle = useRef<HTMLButtonElement>(null);
  const closeMobileSidebar = useCallback(() => { setMobileList(false); mobileSidebarToggle.current?.focus(); }, []);
  useEffect(() => { try { localStorage.setItem('pi-hub.sidebar-collapsed', String(sidebarCollapsed)); } catch { /* Storage may be disabled. */ } }, [sidebarCollapsed]);
  useEffect(() => {
    if (!mobileList) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeMobileSidebar(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileList, closeMobileSidebar]);
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)');
    const close = () => setMobileList(false);
    media.addEventListener('change', close);
    return () => media.removeEventListener('change', close);
  }, []);
  const [commandHelp, setCommandHelp] = useState<SlashCommand[] | null>(null);
  const commandCache = useRef(new Map<string, SlashCommand[]>());
  const wsRef = useRef<WebSocket | null>(null), pending = useRef(new Map<string, { resolve: (r: RecordData) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const bottom = useRef<HTMLDivElement>(null), follow = useRef(true), fileInput = useRef<HTMLInputElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef<{ agentId: string; height: number; top: number } | null>(null);
  const [histories, setHistories] = useState<Record<string, HistoryView | undefined>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const agent = agents[selected];
  const agentsRef = useRef(agents); agentsRef.current = agents;
  const history = histories[selected]?.session === historySession(agent) ? histories[selected] : undefined;
  const displayedMessages = useMemo(() => {
    const recent = visibleMessages(agent?.messages || []).slice(-MESSAGE_PAGE_SIZE);
    return history ? mergeMessages(history.messages, recent) : recent;
  }, [agent?.messages, history]);
  const hasEarlier = history ? history.hasMore : !!agent?.hasEarlierMessages || visibleMessages(agent?.messages || []).length > MESSAGE_PAGE_SIZE;
  const currentSelection = useRef(selected); currentSelection.current = selected;
  async function fetchCommands(id: string): Promise<SlashCommand[]> {
    const response = await rpc({ type: 'get_commands' }, id);
    const commands = commandList(response.data?.commands);
    commandCache.current.set(id, commands);
    return commands;
  }
  const loadCommands = useCallback(() => fetchCommands(selected), [selected, connected, agent?.online]);
  useEffect(() => { void Promise.allSettled([api('auth/status').then(status => setTwoFactor(status.twoFactorEnabled)), api('me').then(() => setAuthed(true))]).finally(() => setChecking(false)); }, []);
  useEffect(() => {
    if (!authed) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>, delay = 1000;
    function connect() {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); wsRef.current = ws;
      ws.onopen = () => { setConnected(true); delay = 1000; setError(''); };
      ws.onmessage = event => {
        const r = JSON.parse(event.data);
        if (r.type === 'agent') {
          setAgents(prev => ({ ...prev, [r.agent.id]: r.agent }));
          setHistories(prev => {
            const old = prev[r.agent.id]; if (!old) return prev;
            return { ...prev, [r.agent.id]: old.session === historySession(r.agent) ? { ...old, messages: mergeMessages(old.messages, visibleMessages(r.agent.messages || [])) } : undefined };
          });
        }
        if (r.type === 'agents') {
          setAgents(prev => {
            const next: Record<string, AgentState> = {};
            for (const a of r.agents) next[a.id] = { ...prev[a.id], ...a }; return next;
          });
          setSelected(prev => {
            if (r.agents.some((a: AgentState) => a.id === prev)) return prev;
            const replacement = r.replacements?.[prev];
            return r.agents.some((a: AgentState) => a.id === replacement) ? replacement : r.agents[0]?.id || '';
          });
        }
        if (r.type === 'reply') { const p = pending.current.get(r.id); if (p) { clearTimeout(p.timer); pending.current.delete(r.id); r.success ? p.resolve(r) : p.reject(new Error(r.error || 'Command failed')); } }
      };
      ws.onclose = () => {
        setConnected(false);
        for (const p of pending.current.values()) { clearTimeout(p.timer); p.reject(new Error('Connection lost. Command may still have been accepted; check history before resending.')); } pending.current.clear();
        if (!stopped) {
          const retry = () => { if (!stopped) { timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 15_000); } };
          api('me').then(retry).catch(e => { if (!stopped && e.status === 401) { setAuthed(false); void api('auth/status').then(status => setTwoFactor(status.twoFactorEnabled)).catch(() => {}); } else retry(); });
        }
      };
    }
    connect(); return () => { stopped = true; clearTimeout(timer); wsRef.current?.close(); };
  }, [authed]);
  useEffect(() => { if (follow.current) bottom.current?.scrollIntoView({ behavior: 'instant' }); }, [agent?.updatedAt, selected]);
  useEffect(() => { setModels([]); }, [selected]);
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current, el = conversation.current;
    if (anchor && anchor.agentId === selected && el) {
      el.scrollTop = anchor.top + el.scrollHeight - anchor.height;
      scrollAnchor.current = null;
    }
  }, [displayedMessages, selected]);
  async function showEarlier() {
    if (!agent || !displayedMessages.length || historyLoading[selected]) return;
    const id = selected, session = historySession(agent), currentMessages = displayedMessages;
    setHistoryLoading(prev => ({ ...prev, [id]: true })); follow.current = false;
    try {
      const page = await api(`agents/${encodeURIComponent(id)}/history?before=${encodeURIComponent(messageKey(currentMessages[0]))}`);
      if (historySession(agentsRef.current[id]) !== session) return;
      const el = conversation.current;
      if (currentSelection.current === id && el) scrollAnchor.current = { agentId: id, height: el.scrollHeight, top: el.scrollTop };
      setHistories(prev => ({ ...prev, [id]: {
        messages: mergeMessages(page.messages, prev[id]?.messages || currentMessages, visibleMessages(agentsRef.current[id]?.messages || [])),
        hasMore: page.hasMore, limited: page.limited, session,
      } }));
    } catch (e) { setError((e as Error).message); }
    finally { setHistoryLoading(prev => ({ ...prev, [id]: false })); }
  }
  function backToLatest() {
    scrollAnchor.current = null; follow.current = true;
    setHistories(prev => ({ ...prev, [selected]: undefined }));
    requestAnimationFrame(() => bottom.current?.scrollIntoView({ behavior: 'instant' }));
  }
  function rpc(command: RecordData, agentId = selected, type = 'command'): Promise<RecordData> {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Hub is disconnected'));
    const id = crypto.randomUUID();
    const payload = JSON.stringify({ type, id, agentId, command });
    if (new Blob([payload]).size > 16 * 1024 * 1024) return Promise.reject(new Error('Message and attachments exceed 16 MB. Send fewer files.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.current.delete(id); reject(new Error('No confirmation received; command may still be running.')); }, 35_000);
      pending.current.set(id, { resolve, reject, timer });
      wsRef.current!.send(payload);
    });
  }
  function act(command: RecordData) { void rpc(command).catch(e => setError(e.message)); }
  async function webCommand(name: string, args: string, target: string): Promise<boolean> {
    switch (name) {
      case 'help': setCommandHelp(await fetchCommands(target)); break;
      case 'settings': case 'session': setPanel(true); break;
      case 'model': {
        const response = await rpc({ type: 'get_available_models' }, target);
        const available: RecordData[] = response.data.models;
        if (!args) { if (currentSelection.current === target) { setModels(available); setPanel(true); } break; }
        const matches = available.filter(m => `${m.provider}/${m.id}` === args || m.id === args);
        if (matches.length !== 1) throw new Error('Specify one available model as /model provider/model-id, or use /model to choose.');
        await rpc({ type: 'set_model', provider: matches[0].provider, modelId: matches[0].id }, target); break;
      }
      case 'thinking':
        if (!args) { setPanel(true); break; }
        if (!['off','minimal','low','medium','high','xhigh','max'].includes(args)) throw new Error('Use /thinking off|minimal|low|medium|high|xhigh|max');
        await rpc({ type: 'set_thinking_level', level: args }, target); break;
      case 'name': {
        const name = args || window.prompt('Agent name', agentsRef.current[target]?.name);
        if (!name) return false;
        await rpc({ type: 'set_session_name', name }, target); break;
      }
      case 'compact': await rpc({ type: 'compact', customInstructions: args || undefined }, target); break;
      case 'abort': await rpc({ type: 'abort' }, target); break;
      case 'export': exportTranscript(); break;
      case 'copy': {
        const last = agentsRef.current[target]?.messages?.findLast(m => m.role === 'assistant');
        const text = typeof last?.content === 'string' ? last.content : last?.content?.filter((b: RecordData) => b.type === 'text').map((b: RecordData) => b.text).join('\n');
        if (!text) throw new Error('No assistant reply to copy yet.');
        await navigator.clipboard.writeText(text); break;
      }
      default: throw new Error('Unsupported web command');
    }
    return true;
  }
  async function submit() {
    if (sending || !connected || !agent?.online || (!draft.trim() && !images.length)) return;
    const text = draft, imgs = images, target = selected;
    setSending(true); setError('');
    try {
      const slash = parseSlashCommand(text);
      if (text.trimStart().startsWith('/') && !slash) throw new Error('Choose a slash command first.');
      if (slash) {
        let commands = commandCache.current.get(target) || commandList([]);
        let command = commands.find(c => c.name === slash.name);
        if (!command) { commands = await fetchCommands(target); command = commands.find(c => c.name === slash.name); }
        if (!command) throw new Error(`Unknown command /${slash.name}. Refresh the list or run /reload in Pi.`);
        if (command.unavailable) throw new Error(`/${slash.name} requires the Pi CLI. ${command.description}`);
        if (command.source === 'web') {
          if (imgs.length) throw new Error('Web control commands do not accept attachments.');
          if (!await webCommand(slash.name, slash.args, target)) return;
        } else await rpc({ type: 'prompt', message: text.trimStart(), images: imgs, streamingBehavior: behavior }, target);
      } else await rpc({ type: 'prompt', message: text || '(see attached image)', images: imgs, streamingBehavior: behavior }, target);
      if (currentSelection.current === target) { setDraft(''); setImages([]); setAttachments([]); }
    } catch (e) { setError((e as Error).message); } finally { setSending(false); }
  }
  async function attach(files: FileList | null) {
    if (!files) return;
    try {
      for (const f of Array.from(files)) {
        if (f.size > 4 * 1024 * 1024) throw new Error('Maximum attachment size is 4 MB');
        if (['image/png','image/jpeg','image/webp','image/gif'].includes(f.type)) {
          const data = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(f); });
          setImages(prev => [...prev, { type: 'image', mimeType: f.type, data }]);
        } else if (/\.(txt|md|tex|json|csv|ts|js|py|lean|typ|yaml|yml|log)$/i.test(f.name)) {
          const text = await f.text(); setDraft(prev => prev + `\n\nAttached file: ${f.name}\n<file-content>\n${text}\n</file-content>`);
        } else throw new Error('Attach an image or text/source file. For binary files, ask the agent to email them.');
        setAttachments(prev => [...prev, f.name]);
      }
    } catch (e) { setError((e as Error).message); }
    if (fileInput.current) fileInput.current.value = '';
  }
  function exportTranscript() {
    const blob = new Blob([JSON.stringify({ ...agent, messages: displayedMessages }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `${agent.name.replace(/[^a-z0-9_-]/gi, '-')}.json`; a.click(); URL.revokeObjectURL(url);
  }
  if (checking) return <div className="login"><span className="logo">π</span><p>Connecting to your workspace…</p></div>;
  if (!authed) return <div className="login"><div className="login-card"><span className="logo">π</span><div className="eyebrow">Your private workspace</div><h1>Pi, wherever you are.</h1><p>A quiet place for your agents, ideas, and mathematics.</p><form onSubmit={async e => { e.preventDefault(); try { await api('login', { password, trustBrowser: twoFactor && trustBrowser, ...(twoFactor ? useRecovery ? { recoveryCode: loginCode } : { code: loginCode } : {}) }); setPassword(''); setLoginCode(''); setTrustBrowser(false); setError(''); setAuthed(true); } catch (e) { setError((e as Error).message); void api('auth/status').then(status => setTwoFactor(status.twoFactorEnabled)).catch(() => {}); } }}><label htmlFor="password">Workspace password</label><input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)}/>{twoFactor && <><label htmlFor="login-code">{useRecovery ? 'One-use recovery code' : 'Authenticator code'}</label><input id="login-code" spellCheck={false} autoCapitalize="none" autoComplete={useRecovery ? 'off' : 'one-time-code'} inputMode={useRecovery ? 'text' : 'numeric'} maxLength={useRecovery ? 100 : 6} pattern={useRecovery ? undefined : '[0-9]{6}'} required value={loginCode} onChange={e => setLoginCode(e.target.value)}/><button type="button" className="subtle" onClick={() => { setUseRecovery(!useRecovery); setLoginCode(''); }}>{useRecovery ? 'Use authenticator instead' : 'Use a recovery code'}</button><label className="checkbox-label"><input type="checkbox" checked={trustBrowser} onChange={e => setTrustBrowser(e.target.checked)}/>Trust this browser for 30 days</label><small>Stay signed in on this personal device. You can revoke it in Security settings.</small></>}<button className="primary">Enter workspace →</button></form>{error && <p className="error" role="alert">{error}</p>}<small>Your agents and files remain on your computer.</small></div></div>;
  return <div className={'app' + (sidebarCollapsed ? ' sidebar-collapsed' : '')}>
    {mobileList && <button type="button" className="sidebar-backdrop mobile-only" aria-label="Dismiss sidebar" onClick={closeMobileSidebar}/>}
    <aside id="agent-sidebar" aria-label="Agents and workspace navigation" className={'sidebar ' + (mobileList ? 'shown' : '')}><div className="brand"><span className="logo">π</span><div><strong>Pi Hub</strong><small>YOUR WORKSPACE</small></div><button className="mobile-only subtle" aria-label="Close sidebar" onClick={closeMobileSidebar}>×</button></div>
      <div className="connection"><span className={'dot ' + (connected ? 'online' : '')}/>{connected ? 'Connected to workspace' : 'Reconnecting…'}</div>
      <button className="new-agent" disabled={!connected} onClick={async () => { try { const r = await api('projects'); setProjects(r.projects); setProject(r.projects[0]?.path || r.root); setMobileList(false); setLaunching(true); } catch (e) { setError((e as Error).message); } }}>＋ New agent</button>
      <div className="section-title">AGENTS <span>{Object.keys(agents).length}</span></div><nav>{Object.values(agents).map(a => <button className={'agent-item ' + (selected === a.id ? 'active' : '')} key={a.id} onClick={() => { setSelected(a.id); closeMobileSidebar(); follow.current = true; }}><div className="row"><span className={'dot ' + (a.online ? a.busy ? 'busy' : 'online' : '')}/><strong>{a.name}</strong></div><small>{a.cwd?.split('/').pop()} · {a.online ? a.busy ? 'Working' : 'Ready' : 'Offline'}</small><small className="agent-kind">{a.managed ? 'Browser-managed' : 'Terminal'} · {a.host}</small></button>)}</nav>
      <footer><button className={'subtle security-link ' + (twoFactor ? '' : 'warning')} onClick={() => { setMobileList(false); setSecurity(true); }}>Security · 2FA {twoFactor ? 'on' : 'off'}</button><button className="subtle" onClick={async () => { try { await api('logout', {}); setAuthed(false); setMobileList(false); setAgents({}); setHistories({}); } catch (e) { setError((e as Error).message); } }}>Sign out ↗</button></footer>
    </aside>
    <main><header><div className="workspace-heading"><button type="button" className="desktop-only sidebar-toggle subtle" aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCollapsed} aria-controls="agent-sidebar" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>{sidebarCollapsed ? '☰' : '‹'}</button><button ref={mobileSidebarToggle} type="button" className="mobile-only sidebar-toggle subtle" aria-label="Open sidebar" aria-expanded={mobileList} aria-controls="agent-sidebar" onClick={() => setMobileList(true)}>☰</button><div className="workspace-title"><h2 title={agent?.name || 'Your workspace'}>{agent?.name || 'Your workspace'}</h2><small>{agent ? `${agent.model || 'Pi'} · ${agent.thinking || 'default'} thinking` : 'Choose an agent to begin'}</small></div></div>{agent && <div className="header-actions"><span className="status">{!agent.online ? 'Offline' : agent.busy ? '● Working' : '● Ready'}</span><button className="subtle" aria-label="Rename agent" title="Rename agent" disabled={!connected || !agent.online} onClick={() => { const name = window.prompt('Agent name', agent.name); if (name?.trim()) act({ type: 'set_session_name', name: name.trim() }); }}>✎</button><button onClick={() => setPanel(!panel)} aria-expanded={panel}>Activity {Object.values(agent.tools || {}).filter(t => t.running).length || ''}</button></div>}</header>
      {error && <div className="error-banner" role="alert">{error}<button className="subtle" onClick={() => setError('')}>×</button></div>}
      <div className="content"><div className="conversation" ref={conversation} onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160; }}>
        {!agent ? <div className="empty"><span className="logo">π</span><h1>Room to think.</h1><p>Start a new agent or connect a terminal session.<br/>Math, code, and long-running work—all in one place.</p><code>pi -e ./extensions/hub.ts</code></div> : <div className="transcript">{!agent.messages?.length && <div className="empty"><h1>What are we exploring?</h1><p>Write naturally. Mathematics is rendered with KaTeX.<br/>Use $…$ inline, or $$…$$ for display equations.</p><div className="example"><RichText text={'$$H_n(X) = \\ker \\partial_n / \\operatorname{im}\\partial_{n+1}$$'}/></div></div>}
          {(hasEarlier || history) && !!displayedMessages.length && <div className="history-controls">
            <small>{hasEarlier ? `Showing ${displayedMessages.length} messages · older messages hidden` : history?.limited ? 'Beginning of available history · no saved session linked; try /reload in Pi' : 'Beginning of conversation'}</small>
            <div className="row">{hasEarlier && <button disabled={historyLoading[selected]} onClick={() => void showEarlier()}>{historyLoading[selected] ? 'Loading…' : 'Show earlier messages'}</button>}{history && <button className="subtle" onClick={backToLatest}>Back to latest {MESSAGE_PAGE_SIZE}</button>}</div>
          </div>}
          <Transcript messages={displayedMessages} partial={agent.partial} tools={agent.tools}/>
          {Object.values(agent.dialogs || {}).map(d => <Dialog key={d.id} dialog={d} respond={r => act({ type: 'extension_ui_response', id: d.id, ...r })}/>)}
          <MessageQueue queue={agent.queue}/>
          {agent.busy && <div className="working"><span className="dot busy"/> Pi is working. You can steer or queue a follow-up.</div>}
          <div ref={bottom}/></div>}
      </div>
      {panel && agent && <aside className="activity"><div className="row between"><h3>Control room</h3><button className="subtle" onClick={() => setPanel(false)}>×</button></div><small className="path">{agent.cwd}</small>
        <div className="row wrap"><button onClick={exportTranscript}>Save transcript</button><button disabled={!connected || !agent.online || agent.busy} onClick={() => act({ type: 'compact' })}>Compact</button><button disabled={!connected || !agent.online} onClick={() => { const name = window.prompt('Agent name', agent.name); if (name?.trim()) act({ type: 'set_session_name', name: name.trim() }); }}>Rename</button></div>
        <label>Thinking<select value={agent.thinking || 'medium'} onChange={e => act({ type: 'set_thinking_level', level: e.target.value })}>{['off','minimal','low','medium','high','xhigh','max'].map(l => <option key={l}>{l}</option>)}</select></label>
        <button onClick={async () => { try { const r = await rpc({ type: 'get_available_models' }); setModels(r.data.models); } catch (e) { setError((e as Error).message); } }}>Change model</button>{!!models.length && <select aria-label="Model" value="" onChange={e => { const m = models[Number(e.target.value)]; act({ type: 'set_model', provider: m.provider, modelId: m.id }); setModels([]); }}><option value="" disabled>Select a model</option>{models.map((m, i) => <option key={i} value={i}>{m.provider} / {m.id}</option>)}</select>}
        <h4>Tools & background work</h4><ToolActivity tools={agent.tools || {}}/>
        <h4>Lifecycle & subagents</h4>{!(agent.activity || []).length && <p className="muted">Subagent events, retries, and extension notices appear here.</p>}<ActivityFeed events={agent.activity || []}/>
        {agent.managed && <button className="danger" onClick={() => { if (confirm('Stop this managed Pi process? Its session remains saved on disk.')) void rpc({}, selected, 'stop').catch(e => setError(e.message)); }}>Stop agent process</button>}
      </aside>}
      </div>
      {agent && <div className="composer"><div className="composer-box">{!!attachments.length && <div className="attachment-list">{attachments.join(' · ')} <button className="subtle" onClick={() => { setImages([]); setAttachments([]); }}>Clear images</button></div>}<SlashComposer key={selected} agentId={selected} sessionId={agent.sessionId} connected={connected && agent.online} managed={agent.managed} placeholder={agent.busy ? 'Steer the agent, or queue the next idea…' : 'Ask, explore, prove something… (/ for commands)'} value={draft} onChange={setDraft} onSubmit={() => void submit()} loadCommands={loadCommands}/><div className="row between"><div className="row"><input type="file" multiple ref={fileInput} hidden onChange={e => void attach(e.target.files)}/><button className="subtle" title="Attach images or text files" onClick={() => fileInput.current?.click()}>＋ Attach</button>{agent.busy && <select aria-label="Delivery mode" value={behavior} onChange={e => setBehavior(e.target.value)}><option value="steer">Steer now</option><option value="followUp">Follow up later</option></select>}</div><div className="row">{agent.busy && <button className="danger" onClick={() => act({ type: 'abort' })}>Abort</button>}<button className="primary" disabled={sending || !connected || !agent.online || (!draft.trim() && !images.length)} onClick={() => void submit()}>{sending ? 'Sending…' : agent.busy ? 'Queue ↑' : 'Send ↑'}</button></div></div></div><small>Ctrl / ⌘ + Enter to send</small></div>}
    </main>
    {security && <SecuritySettings enabled={twoFactor} onEnabled={() => setTwoFactor(true)} onClose={() => setSecurity(false)}/>}
    {commandHelp && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setCommandHelp(null); }}><section className="modal command-help" role="dialog" aria-modal="true" aria-labelledby="command-help-title" onKeyDown={e => { if (e.key === 'Escape') setCommandHelp(null); }}><div className="row between"><h2 id="command-help-title">Commands</h2><button autoFocus className="subtle" aria-label="Close command help" onClick={() => setCommandHelp(null)}>×</button></div><p>Type / to browse. ↑ ↓ navigate; Tab or Enter completes; Ctrl / ⌘ + Enter sends. Shift + Enter adds a line.</p><div className="command-help-list">{commandHelp.map(c => <div key={c.name}><strong>/{c.name}</strong><small>{c.unavailable ? 'CLI only' : c.source}</small><p>{c.description}</p></div>)}</div><p>Registered extensions, skills, and templates come from the selected agent. Attached-agent extension dialogs may still require its terminal.</p></section></div>}
    {launching && <div className="modal-backdrop"><form className="modal" onSubmit={async e => { e.preventDefault(); try { const r = await api('agents', { cwd: project }); setSelected(r.id); setLaunching(false); } catch (e) { setError((e as Error).message); } }}><div className="eyebrow">New conversation</div><h2>Give an agent a workspace.</h2><label>Project<select value={project} onChange={e => setProject(e.target.value)}>{projects.map(p => <option key={p.path} value={p.path}>{p.name}</option>)}</select></label><label>Directory<input required value={project} onChange={e => setProject(e.target.value)}/></label><p>Uses your existing Pi login and extensions. The process runs independently of this browser.</p><div className="row"><button type="button" onClick={() => setLaunching(false)}>Cancel</button><button className="primary">Start agent →</button></div></form></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
if ('serviceWorker' in navigator && !import.meta.env.DEV) void navigator.serviceWorker.register('/sw.js').catch(() => {});
