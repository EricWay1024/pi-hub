import { useEffect, useRef, useState } from 'react';
import type { FanMode, FanStatus } from '../shared/fan';
import { api } from './api';
import './fan.css';

export function FanControl({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<FanStatus | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  const pending = useRef(false), mounted = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose); close.current = onClose;
  async function update(mode?: FanMode) {
    if (pending.current) return;
    pending.current = true; closeButton.current?.focus(); setBusy(true); setError('');
    try {
      const next = await api('laptop/fan', mode ? { mode } : undefined, 25_000) as FanStatus;
      if (mounted.current) setStatus(next);
    } catch (e) {
      if (mounted.current) {
        setStatus(null);
        setError((e as { status?: number }).status === 404 ? '散热控制后端尚未加载，需要在安全时重启 Pi Hub。' : (e as Error).message + ' 请刷新状态，确认后再操作。');
      }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close.current(); } };
    window.addEventListener('keydown', onKey);
    mounted.current = true; closeButton.current?.focus(); void update();
    return () => { window.removeEventListener('keydown', onKey); mounted.current = false; previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="modal fan-control" role="dialog" aria-modal="true" aria-labelledby="fan-title" onKeyDown={e => {
      if (e.key === 'Tab') {
        const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const first = buttons[0], last = buttons.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="row between"><h2 id="fan-title">笔记本散热</h2><button ref={closeButton} className="subtle" aria-label="关闭散热控制" onClick={onClose}>×</button></div>
      <p>通过 LG Smart Assistant 的厂商接口切换散热档位。不是固定转速，温控仍由电脑管理。</p>
      {status?.model && <small>{status.model}</small>}
      <p role="status" aria-live="polite">{busy ? '正在读取或切换，请稍候…' : status?.available ? `当前：${status.modes.find(mode => mode.id === status.mode)?.label || '未知'}` : '散热控制不可用'}</p>
      {status?.available && <div className="fan-modes" aria-label="散热档位">{status.modes.map(mode => <button key={mode.id} className={status.mode === mode.id ? 'selected' : ''} aria-pressed={status.mode === mode.id} disabled={busy || status.mode === mode.id} onClick={() => void update(mode.id)}><strong>{mode.label}</strong><small>{mode.description}</small></button>)}</div>}
      {status && !status.available && <p>{status.reason}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button disabled={busy} onClick={() => void update()}>刷新状态</button>
      <p><small>切换后会重新读取 LG 接口确认。不支持的机型不会开放控制；不会写入底层寄存器、强制关风扇或绕过温控保护。电脑须保持开机，WSL 和 Pi Hub 须在线。</small></p>
    </section>
  </div>;
}
