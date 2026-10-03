import { useEffect, useId, useRef, useState } from 'react';
import { commandList, filterCommands, slashQuery, type SlashCommand } from '../shared/commands';

interface Props {
  agentId: string; sessionId?: string; connected: boolean; managed: boolean; engine?: 'pi' | 'codex';
  value: string; placeholder: string;
  onChange: (value: string) => void; onSubmit: () => void;
  loadCommands: () => Promise<SlashCommand[]>;
}
export function SlashComposer({ agentId, sessionId, connected, managed, engine = 'pi', value, placeholder, onChange, onSubmit, loadCommands }: Props) {
  const input = useRef<HTMLTextAreaElement>(null), listId = useId();
  const target = `${agentId}:${sessionId || ''}`;
  const [registry, setRegistry] = useState<{ target: string; commands: SlashCommand[] }>({ target, commands: commandList([], engine) });
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [active, setActive] = useState(0), [cursor, setCursor] = useState(value.length), [dismissed, setDismissed] = useState<string | null>(null);
  const generation = useRef(0);
  const commands = registry.target === target ? registry.commands : commandList([], engine);
  const query = slashQuery(value, cursor);
  const open = query !== null && dismissed !== value;
  const matches = filterCommands(commands, query || '');
  const chosen = matches[Math.min(active, matches.length - 1)];

  async function refresh() {
    const version = ++generation.current;
    setLoading(true); setError('');
    try {
      const commands = await loadCommands();
      if (version === generation.current) setRegistry({ target, commands });
    } catch (e) { if (version === generation.current) setError((e as Error).message); }
    finally { if (version === generation.current) setLoading(false); }
  }
  useEffect(() => {
    setRegistry({ target, commands: commandList([], engine) }); setError(''); setActive(0);
    if (connected) void refresh(); else setLoading(false);
    return () => { generation.current++; };
  }, [target, connected, loadCommands, engine]);
  useEffect(() => { setActive(0); }, [value, registry]);
  useEffect(() => { setCursor(input.current?.selectionStart ?? value.length); }, [value]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function choose(command: SlashCommand) {
    if (command.unavailable) return;
    const completed = `/${command.name} `;
    onChange(completed); setCursor(completed.length); setDismissed(null);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(completed.length, completed.length); });
  }
  function move(direction: number) {
    if (!matches.length) return;
    let index = active;
    for (let n = 0; n < matches.length; n++) {
      index = (index + direction + matches.length) % matches.length;
      if (!matches[index].unavailable) { setActive(index); return; }
    }
  }
  return <div className="slash-composer">
    {open && <div className="command-menu">
      <div className="command-menu-heading"><strong>Slash commands</strong><div className="row">{loading && <small>Loading…</small>}<button className="subtle" type="button" disabled={!connected || loading} onClick={() => void refresh()}>Refresh</button></div></div>
      {error && <div className="command-notice" role="status">{error} · Web controls are still listed below.</div>}
      <div id={listId} role="listbox" aria-label="Slash commands" className="command-options">
        {matches.map((command, index) => <button type="button" role="option" aria-selected={chosen === command} aria-disabled={!!command.unavailable} id={`${listId}-${index}`} key={command.name}
          className={'command-option ' + (chosen === command ? 'selected ' : '') + (command.unavailable ? 'unavailable' : '')}
          onMouseDown={e => e.preventDefault()} onMouseMove={e => { if (e.movementX || e.movementY) setActive(index); }} onClick={() => choose(command)}>
          <span className="command-name">/{command.name}{command.argumentHint && <small> {command.argumentHint}</small>}</span>
          <span className="command-source">{command.unavailable ? 'CLI only' : command.source === 'prompt' ? 'Template' : command.source}</span>
          <span className="command-description">{command.description || 'Registered Pi command'}</span>
        </button>)}
        {!matches.length && <div className="command-notice">{loading ? 'Loading agent commands…' : `No matching commands for /${query}.`}</div>}
      </div>
      <div className="command-menu-footer">↑ ↓ navigate · Tab / Enter complete · Esc close{!managed && <span>Extension dialogs may open in your terminal.</span>}</div>
    </div>}
    <textarea ref={input} aria-label="Message Pi" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && chosen ? `${listId}-${Math.min(active, matches.length - 1)}` : undefined}
      placeholder={placeholder} value={value} onChange={e => { onChange(e.target.value); setCursor(e.target.selectionStart); }} onSelect={e => setCursor(e.currentTarget.selectionStart)}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmit(); return; }
        if (!open) return;
        if (e.key === 'Escape') { e.preventDefault(); setDismissed(value); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); return; }
        if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && chosen && !chosen.unavailable) { e.preventDefault(); choose(chosen); }
      }}/>
  </div>;
}
