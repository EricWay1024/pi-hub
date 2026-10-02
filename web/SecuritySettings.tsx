import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { TrustedBrowsers } from './TrustedBrowsers';
export function SecuritySettings({ enabled, onEnabled, onClose }: { enabled: boolean; onEnabled: () => void; onClose: () => void }) {
  const [password, setPassword] = useState(''), [setupToken, setSetupToken] = useState(''), [code, setCode] = useState('');
  const [candidate, setCandidate] = useState<{ challenge: string; secret: string; uri: string } | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const qr = useMemo(() => { if (!candidate) return ''; const image = qrcode(0, 'M'); image.addData(candidate.uri); image.make(); return image.createDataURL(4, 8); }, [candidate]);
  async function post(action: string, data: unknown) {
    const response = await fetch(`/api/auth/enroll/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Enrollment failed'); return result;
  }
  async function begin() {
    setBusy(true); setError('');
    try { setCandidate(await post('start', { password, setupToken })); setPassword(''); setSetupToken(''); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function finish() {
    setBusy(true); setError('');
    try { const result = await post('finish', { challenge: candidate?.challenge, code }); setRecovery(result.recoveryCodes); setCandidate(null); setCode(''); onEnabled(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function downloadCodes() {
    const url = URL.createObjectURL(new Blob(['Pi Hub recovery codes\nEach code is one-use; your workspace password is still required.\n\n' + recovery.join('\n')], { type: 'text/plain' }));
    const link = document.createElement('a'); link.href = url; link.download = 'pi-hub-recovery-codes.txt'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="modal-backdrop"><section className="modal security-modal" role="dialog" aria-modal="true" aria-labelledby="security-title">
    <div className="row between"><h2 id="security-title">Workspace security</h2>{!recovery.length && <button className="subtle" aria-label="Close security settings" onClick={onClose}>×</button>}</div>
    {!!recovery.length ? <><div className="security-status enabled">Two-factor authentication is now enabled.</div><p>Save these recovery codes in a password manager or another safe place. They are shown only once. Each code works once, together with your password.</p><pre className="recovery-codes">{recovery.join('\n')}</pre><button onClick={downloadCodes}>Download recovery codes</button><label className="checkbox-label"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)}/>I saved my recovery codes.</label><button className="primary" disabled={!saved} onClick={onClose}>Done</button></>
    : candidate ? <><p>Scan this QR code with an authenticator app such as 2FAS, Aegis, Google Authenticator, or Microsoft Authenticator.</p><img className="totp-qr" alt="Scan to add Pi Hub to your authenticator" src={qr}/><details><summary>Manual setup key</summary><code className="totp-key">{candidate.secret}</code><p>Time-based · SHA1 · 6 digits · 30 seconds</p></details><form onSubmit={e => { e.preventDefault(); void finish(); }}><label>Authenticator code<input autoFocus spellCheck={false} autoCapitalize="none" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}/></label><button className="primary" disabled={busy}>{busy ? 'Confirming…' : 'Confirm and enable 2FA'}</button></form><small>Enrollment expires in five minutes. 2FA remains off until this code is confirmed.</small></>
    : enabled ? <><div className="security-status enabled">Password + authenticator required</div><p>Authenticator codes and recovery codes are one-use. Normal login sessions expire after 12 hours; trusted browsers stay signed in for up to 30 days. Other sessions were revoked when 2FA was enabled.</p><p>If your authenticator is lost, use a saved recovery code. Local emergency reset instructions are in README.md.</p><TrustedBrowsers/></>
    : <><div className="security-status warning">2FA is not enabled yet.</div><p>First prove access to your laptop and workspace password. On the machine running Pi Hub, read the owner-only file:</p><code className="setup-token-path">~/.config/pi-hub/config.json.2fa-enrollment-token</code><form onSubmit={e => { e.preventDefault(); void begin(); }}><label>Workspace password<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)}/></label><label>Laptop enrollment token<input type="password" autoComplete="off" required value={setupToken} onChange={e => setSetupToken(e.target.value)}/></label><button className="primary" disabled={busy}>{busy ? 'Preparing…' : 'Set up authenticator'}</button></form><small>Your current login keeps working until you confirm an authenticator code.</small></>}
    {error && <p className="error" role="alert">{error}</p>}
  </section></div>;
}
