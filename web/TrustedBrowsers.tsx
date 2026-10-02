import { useEffect, useState } from 'react';
type Device = { id: string; label: string; created: number; expires: number; current: boolean };
export function TrustedBrowsers() {
  const [devices, setDevices] = useState<Device[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch('/api/auth/trusted'); const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load trusted browsers'); setDevices(data.browsers);
  }
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  async function revoke(id: string) {
    if (!confirm(id === 'all' ? 'Forget every trusted browser? They will need password and 2FA again.' : 'Forget this browser? It will need password and 2FA again.')) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/trusted/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not revoke browser');
      if (id === 'all' && devices.some(d => d.current) || devices.some(d => d.id === id && d.current)) { location.reload(); return; }
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="trusted-browsers"><h3>Trusted browsers</h3><p>Select “Trust this browser for 30 days” at a fresh 2FA login to stay signed in, including across hub restarts. Only use it on your own secured device.</p>
    {devices.length ? <><ul>{devices.map(d => <li key={d.id}><div><strong>{d.label}{d.current ? ' · This browser' : ''}</strong><small>Added {new Date(d.created).toLocaleString()}<br/>Expires {new Date(d.expires).toLocaleString()}</small></div><button disabled={busy} onClick={() => void revoke(d.id)}>Forget</button></li>)}</ul><button className="danger" disabled={busy} onClick={() => void revoke('all')}>Forget all trusted browsers</button></> : <small>No trusted browsers. Normal logins last 12 hours.</small>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
