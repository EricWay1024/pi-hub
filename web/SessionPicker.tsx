import { useEffect, useRef, useState } from 'react';
import type { SavedSession, SessionPage } from '../shared/sessions';

type Row = SavedSession & { agentId?: string };
type Page = Omit<SessionPage, 'sessions'> & { sessions: Row[] };
export function SessionPicker({ projects, initialWorkspace, onResume, onClose }: { projects: { name: string; path: string }[]; initialWorkspace: string; onResume: (id: string) => void; onClose: () => void }) {
  const [workspace, setWorkspace] = useState(initialWorkspace), [engine, setEngine] = useState('all'), [query, setQuery] = useState('');
  const [page, setPage] = useState<Page>(), [loading, setLoading] = useState(false), [pending, setPending] = useState(''), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const focus = useRef<HTMLElement | null>(document.activeElement as HTMLElement);
  useEffect(() => () => { request.current?.abort(); focus.current?.focus(); }, []);
  async function load(cursor?: string, refresh = false) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    const params = new URLSearchParams({ engine, q: query }); if (workspace.trim()) params.set('cwd', workspace.trim()); if (cursor) params.set('cursor', cursor); if (refresh) params.set('refresh', '1');
    try {
      const response = await fetch('/api/sessions?' + params, { signal: controller.signal }), result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Session discovery failed');
      if (!controller.signal.aborted) setPage(old => cursor && old ? { ...result, sessions: [...old.sessions, ...result.sessions] } : result);
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    request.current?.abort(); setPage(undefined); setLoading(true);
    const timer = setTimeout(() => void load(), 250);
    return () => { clearTimeout(timer); request.current?.abort(); };
  }, [engine, workspace, query]);
  async function resume(session: Row) {
    setPending(session.key); setError('');
    try {
      const response = await fetch('/api/sessions/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: session.key }) }), result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Resume failed');
      onResume(result.id);
    } catch (e) { setError(`Resume not confirmed: ${(e as Error).message}. It may have started; refresh the list before trying again.`); }
    finally { setPending(''); }
  }
  const paths = new Map(projects.map(p => [p.path, p.name])); if (initialWorkspace && !paths.has(initialWorkspace)) paths.set(initialWorkspace, initialWorkspace);
  for (const session of page?.sessions || []) if (!paths.has(session.cwd)) paths.set(session.cwd, session.cwd);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !pending) onClose(); }}>
    <section className="modal session-picker" role="dialog" aria-modal="true" aria-labelledby="session-picker-title" onKeyDown={e => {
      if (e.key === 'Escape' && !pending) { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') {
        const elements = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
        const first = elements[0], last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="row between"><h2 id="session-picker-title">Resume sessions</h2><button autoFocus type="button" className="subtle" aria-label="Close saved sessions" disabled={!!pending} onClick={onClose}>×</button></div>
      <p>Reopen saved conversations, newest first. Choose a workspace, or browse them all.</p>
      <div className="session-filters"><label>Workspace<select aria-label="Session workspace" value={paths.has(workspace) ? workspace : ''} disabled={!!pending} onChange={e => setWorkspace(e.target.value)}><option value="">All workspaces</option>{[...paths].sort((a, b) => a[1].localeCompare(b[1])).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label>Engine<select aria-label="Session engine" value={engine} disabled={!!pending} onChange={e => setEngine(e.target.value)}><option value="all">Pi + Codex</option><option value="pi">Pi</option><option value="codex">Codex CLI</option></select></label></div>
      <label>Workspace directory (optional)<input aria-label="Session directory" placeholder="Leave empty for all workspaces" disabled={!!pending} value={workspace} onChange={e => setWorkspace(e.target.value)}/></label>
      <label>Search sessions<input aria-label="Search sessions" maxLength={100} placeholder="Name, first message, folder, or session ID" disabled={!!pending} value={query} onChange={e => setQuery(e.target.value)}/></label>
      <div className="row between"><small aria-live="polite">{loading ? 'Loading sessions…' : `${page?.sessions.length || 0} sessions shown`}</small><button type="button" disabled={loading || !!pending} onClick={() => void load(undefined, true)}>Refresh list</button></div>
      {error && <p className="error" role="alert">{error}</p>}{page?.warnings.map(w => <p className="error" key={w}>{w}</p>)}
      <div className="saved-session-list" aria-busy={loading}>
        {page?.sessions.map(session => <article className="saved-session" key={session.key}><div className="saved-session-copy"><strong>{session.name}</strong><small>{session.engine === 'codex' ? 'Codex CLI' : 'Pi'} · {new Date(session.updatedAt).toLocaleString()}{session.messageCount !== undefined ? ` · ${session.messageCount} messages` : ''}</small><code title={session.cwd}>{session.cwd}</code>{session.preview && session.preview !== session.name && <p>{session.preview}</p>}</div><button type="button" disabled={!!pending || loading} onClick={() => void resume(session)}>{pending === session.key ? 'Opening…' : session.agentId ? 'Open running' : 'Resume'}</button></article>)}
        {!loading && page && !page.sessions.length && <p className="muted">No saved sessions match these filters.</p>}
      </div>
      {page?.cursor && <button type="button" disabled={loading || !!pending} onClick={() => void load(page.cursor)}>Load more sessions</button>}
      {page?.limited && <small>Only the newest 2,000 sessions are indexed. Narrow the workspace filter for older conversations.</small>}
      <small>Already running in Hub? We open that agent instead. For a session running in an external terminal, finish or close it there first—this resumes saved history, not that live process. No prompt is sent automatically.</small>
    </section>
  </div>;
}
