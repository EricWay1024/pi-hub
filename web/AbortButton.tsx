import { useEffect, useState } from 'react';

export function AbortButton({ agentId, busy, disabled, onAbort }: { agentId: string; busy: boolean; disabled: boolean; onAbort: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { setArmed(false); }, [agentId, busy, disabled]);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return <button type="button" className={'danger' + (armed ? ' abort-confirming' : '')} disabled={disabled}
    aria-label={armed ? 'Confirm abort' : 'Abort'} title={armed ? 'Tap again within 3 seconds to abort' : 'Tap twice to abort'}
    onBlur={() => setArmed(false)} onClick={() => { if (armed) { setArmed(false); onAbort(); } else setArmed(true); }}>
    {armed ? 'Abort?' : 'Abort'}
  </button>;
}
