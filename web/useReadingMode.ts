import { useCallback, useEffect, useRef, useState } from 'react';

export function useReadingMode(enabled: boolean) {
  const [active, setActive] = useState(false);
  const [top, setTop] = useState(false), [bottom, setBottom] = useState(false);
  const ownsFullscreen = useRef(false), previousFocus = useRef<HTMLElement | null>(null);
  const topTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), bottomTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exit = useCallback(() => {
    setActive(false); setTop(false); setBottom(false);
    clearTimeout(topTimer.current); clearTimeout(bottomTimer.current);
    if (ownsFullscreen.current && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    ownsFullscreen.current = false;
    requestAnimationFrame(() => { const target = previousFocus.current?.isConnected ? previousFocus.current : document.querySelector<HTMLElement>('button[aria-label="Activity"]'); target?.focus({ preventScroll: true }); });
  }, []);
  const toggle = useCallback(() => {
    if (active) { exit(); return; }
    if (!enabled) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousFocus.current?.blur(); setTop(false); setBottom(false); setActive(true);
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      ownsFullscreen.current = true;
      void document.documentElement.requestFullscreen().catch(() => { ownsFullscreen.current = false; });
    }
  }, [active, enabled, exit]);
  useEffect(() => { if (!enabled && active) exit(); }, [enabled, active, exit]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'F11' && enabled) { e.preventDefault(); if (!e.repeat) toggle(); }
      if (e.key === 'Escape' && active) { e.preventDefault(); exit(); }
    };
    const fullscreen = () => { if (ownsFullscreen.current && !document.fullscreenElement) exit(); };
    window.addEventListener('keydown', key); document.addEventListener('fullscreenchange', fullscreen);
    return () => { window.removeEventListener('keydown', key); document.removeEventListener('fullscreenchange', fullscreen); };
  }, [active, enabled, toggle, exit]);
  useEffect(() => {
    if (!active) return;
    const reveal = (edge: 'top' | 'bottom', show: boolean) => {
      const timer = edge === 'top' ? topTimer : bottomTimer, set = edge === 'top' ? setTop : setBottom;
      clearTimeout(timer.current);
      if (show) set(true); else timer.current = setTimeout(() => set(false), 900);
    };
    const move = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      reveal('top', e.clientY <= 48 || !!target?.closest('header'));
      reveal('bottom', e.clientY >= window.innerHeight - 64 || !!target?.closest('.composer'));
    };
    const touch = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || (e.target instanceof Element && e.target.closest('button,input,textarea,select'))) return;
      setTop(true); setBottom(true);
      clearTimeout(topTimer.current); clearTimeout(bottomTimer.current);
      topTimer.current = setTimeout(() => setTop(false), 2200); bottomTimer.current = setTimeout(() => setBottom(false), 2200);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerdown', touch);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerdown', touch); clearTimeout(topTimer.current); clearTimeout(bottomTimer.current); };
  }, [active]);
  return { active, top, bottom, toggle, exit };
}
