import { useState } from 'react';
import type { RecordData } from '../shared/state';
export function CodexDialog({ dialog, respond }: { dialog: RecordData; respond: (value: RecordData) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}), [sending, setSending] = useState(false);
  const params = dialog.params || {}, input = dialog.request === 'item/tool/requestUserInput';
  const send = (value: RecordData) => { if (sending) return; setSending(true); respond(value); setTimeout(() => setSending(false), 1500); };
  return <section className="dialog"><h3>{dialog.title}</h3>{params.reason && <p>{params.reason}</p>}{params.command && <pre>{params.command}</pre>}{params.previewChanges?.map((change: RecordData, i: number) => <div key={i}><code>{change.path}</code><pre>{change.diff}</pre></div>)}
    {!input && <p>{dialog.request === 'item/fileChange/requestApproval' ? 'Allow these file changes?' : 'Allow this command once?'}{params.grantRoot ? ` Requested path: ${params.grantRoot}` : ''}</p>}
    {input ? <form onSubmit={e => { e.preventDefault(); send({ answers: Object.fromEntries((params.questions || []).map((q: RecordData) => [q.id, [answers[q.id] || '']])) }); }}>
      {(params.questions || []).map((q: RecordData) => <label key={q.id}>{q.header}: {q.question}{q.options?.length && !q.isOther ? <select required value={answers[q.id] || ''} onChange={e => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}><option value="" disabled>Select an answer</option>{q.options.map((o: RecordData) => <option key={o.label} value={o.label}>{o.label} — {o.description}</option>)}</select> : <input required placeholder={q.options?.map((o: RecordData) => o.label).join(' / ')} type={q.isSecret ? 'password' : 'text'} value={answers[q.id] || ''} onChange={e => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}/>}</label>)}<button disabled={sending}>Submit answers</button></form>
      : <div className="row"><button disabled={sending || Array.isArray(params.availableDecisions) && !params.availableDecisions.includes('accept')} onClick={() => send({ decision: 'accept' })}>Approve once</button><button disabled={sending} className="danger" onClick={() => send({ decision: 'decline' })}>Deny</button><button disabled={sending} onClick={() => send({ decision: 'cancel' })}>Cancel</button></div>}
  </section>;
}
