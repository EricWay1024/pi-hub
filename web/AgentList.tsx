import { useRef, useState } from 'react';
import { agentStatus, type AgentState } from '../shared/state';
import { orderedIds, moveAgent } from '../shared/agent-order';

const key = 'pi-hub.agent-order';
export function AgentList({ agents, selected, select }: { agents: Record<string, AgentState>; selected: string; select: (id: string) => void }) {
  const [order, setOrder] = useState<string[]>(() => { try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(0, 500) : []; } catch { return []; } });
  const [editing, setEditing] = useState(false), [target, setTarget] = useState('');
  const dragging = useRef('');
  const ids = orderedIds(order, Object.keys(agents));
  const save = (next: string[]) => { setOrder(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Storage-disabled browsers still reorder this visit. */ } };
  const drop = (id?: string, after = false) => { if (dragging.current && agents[dragging.current]) save(moveAgent(ids, dragging.current, id, after)); dragging.current = ''; setTarget(''); };
  return <div className="agent-list"><div className="section-title"><span>AGENTS · {ids.length}</span><button className="subtle reorder-toggle" aria-label="Reorder agents" aria-pressed={editing} title="Drag handles to reorder, or use move buttons" onClick={() => setEditing(!editing)}>↕</button></div>
    <nav aria-label="Agent list" onDragOver={e => { if (dragging.current) e.preventDefault(); }} onDrop={e => { if (dragging.current) { e.preventDefault(); drop(); } }}>
      {ids.map((id, index) => { const a = agents[id]; return <div key={id} className={'agent-entry' + (target === id ? ' drop-target' : '')} onDragOver={e => { if (dragging.current) { e.preventDefault(); e.stopPropagation(); setTarget(id); e.dataTransfer.dropEffect = 'move'; } }} onDrop={e => { if (dragging.current) { e.preventDefault(); e.stopPropagation(); drop(id, e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2); } }}>
        <button className={'agent-item' + (selected === id ? ' active' : '')} onClick={() => select(id)}><div className="row"><span className={'dot ' + (a.online ? a.busy ? 'busy' : 'online' : '')}/><strong>{a.name}</strong></div><small>{a.cwd?.split('/').pop()} · {agentStatus(a)}</small><small className="agent-kind">{a.managed ? 'Browser-managed' : 'Terminal'} · {a.host}</small></button>
        <button className="agent-drag subtle" draggable aria-label={`Drag to reorder ${a.name}`} title="Drag to reorder; use ↕ for move buttons" onDragStart={e => { dragging.current = id; e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { dragging.current = ''; setTarget(''); }} onClick={() => setEditing(true)}>⠿</button>
        {editing && <div className="agent-moves"><button disabled={index === 0} aria-label={`Move ${a.name} up`} onClick={() => save(moveAgent(ids, id, ids[index - 1]))}>↑ Up</button><button disabled={index === ids.length - 1} aria-label={`Move ${a.name} down`} onClick={() => save(moveAgent(ids, id, ids[index + 1], true))}>↓ Down</button></div>}
      </div>; })}
    </nav>
  </div>;
}
