import { useState } from 'react';
import type { RecordData } from '../shared/state';
import { cleanTerminal, contentBlocks, hasText, humanLabel, outputText, parseOutput, toolPresentation, toolStatus } from '../shared/output';
import { RichText } from './RichText';

export function OutputText({ text, code = false, diff = false, compact = false }: { text: string; code?: boolean; diff?: boolean; compact?: boolean }) {
  const [full, setFull] = useState(false);
  const clean = cleanTerminal(text), lines = clean.split('\n'), lineLimit = compact ? 5 : 10;
  const preview = lines.slice(0, lineLimit).join('\n').slice(0, compact ? 800 : 1800);
  const clipped = preview.length < clean.length;
  const shown = full ? clean : preview;
  if (!hasText(clean)) return null;
  return <div className="output-text">{diff ? <pre className="diff-output">{shown.split('\n').map((line, i) => <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : ''}>{line || ' '}</span>)}</pre> : code ? <pre><code>{shown}</code></pre> : <div className="formatted-output"><RichText text={shown}/></div>}
    {clipped && <button className="output-toggle subtle" onClick={() => setFull(!full)}>{full ? 'Show less' : `Show full output · ${lines.length} lines`}</button>}
  </div>;
}
export function OutputValue({ value, depth = 0, compact = false }: { value: unknown; depth?: number; compact?: boolean }) {
  const [all, setAll] = useState(false);
  if (value === null || value === undefined) return <span className="muted">—</span>;
  if (typeof value === 'string') return <OutputText text={value} compact={compact}/>;
  if (typeof value !== 'object') return <span>{typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value)}</span>;
  if (depth > 5) return <details><summary>Nested details</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">None</span>;
    const limit = compact ? 4 : 8;
    return <div className="output-list">{(all ? value : value.slice(0, limit)).map((v, i) => <div className="output-list-item" key={i}><OutputValue value={v} depth={depth + 1} compact={compact}/></div>)}{value.length > limit && <button className="subtle output-toggle" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show ${value.length - limit} more items`}</button>}</div>;
  }
  const object = value as RecordData;
  const agent = object.agent || object.agentName;
  const status = object.status || object.state;
  const entries = Object.entries(object).filter(([key, v]) => v !== undefined && !['thinkingSignature', 'textSignature'].includes(key) && (!agent || !['agent','agentName','state','status'].includes(key)));
  const limit = compact ? 8 : 18;
  return <div className={'structured-output ' + (agent ? 'subagent-report' : '')}>
    {typeof agent === 'string' && <div className="report-heading"><strong>{agent}</strong>{typeof status === 'string' && <span className="result-status">{humanLabel(status)}</span>}</div>}
    <dl>{(all ? entries : entries.slice(0, limit)).map(([key, v]) => <div key={key}><dt>{humanLabel(key)}</dt><dd><OutputValue value={v} depth={depth + 1} compact={compact}/></dd></div>)}</dl>
    {entries.length > limit && <button className="subtle output-toggle" onClick={() => setAll(!all)}>{all ? 'Show fewer fields' : `Show ${entries.length - limit} more fields`}</button>}
  </div>;
}
export function ToolCard({ name, args = {}, result, execution, compact = false }: { name: string; args?: RecordData; result?: RecordData; execution?: RecordData; compact?: boolean }) {
  name = typeof name === 'string' && name ? name : 'tool';
  args = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const view = toolPresentation(name, args), status = toolStatus(result, execution);
  const output = result || execution?.result || execution?.partialResult;
  const text = outputText(output), parsed = parseOutput(text);
  const patch = output?.details?.patch || output?.details?.diff;
  const inputContent = typeof args.content === 'string' ? args.content : undefined;
  const edits = Array.isArray(args.edits) ? args.edits : hasText(args.oldText) || hasText(args.newText) ? [args] : [];
  const images = contentBlocks(output || {}).filter(b => b.type === 'image' && ['image/png','image/jpeg','image/webp','image/gif'].includes(b.mimeType));
  const known = ['bash','read','write','edit','apply_patch'].includes(view.kind);
  const metadata = Object.fromEntries(Object.entries(output?.details || {}).filter(([key]) => !['patch','diff','exitCode','fullOutputPath'].includes(key)));
  return <section className={'tool-card ' + status + (compact ? ' compact-tool' : '')}>
    <div className="tool-card-heading"><strong>{view.title}</strong><span className={'result-status ' + status}>{status === 'pending' ? 'Queued' : status === 'done' ? 'Done' : status === 'running' ? 'Running' : 'Error'}</span></div>
    {view.path && <code className="tool-path">{view.path}</code>}
    {view.command && <OutputText text={view.command} code compact={true}/>}
    {view.agent && <p className="tool-subtitle">{view.agent}{view.action ? ` · ${view.action}` : ''}</p>}
    {inputContent && <p className="tool-subtitle">{inputContent.split('\n').length} lines written</p>}
    {hasText(text) && <div className="tool-output">{typeof parsed === 'string' ? <OutputText text={parsed} code={['bash','read'].includes(view.kind)} compact={compact}/> : <OutputValue value={parsed} compact={compact}/>}</div>}
    {hasText(patch) && <OutputText text={patch} diff compact={compact}/>}
    {!patch && edits.length > 0 && <details className="tool-input"><summary>{edits.length} change{edits.length === 1 ? '' : 's'}</summary>{edits.map((edit: RecordData, i: number) => <div className="edit-change" key={i}><div className="diff-label">Before</div><OutputText text={edit.oldText || ''} code compact={compact}/><div className="diff-label">After</div><OutputText text={edit.newText || ''} code compact={compact}/></div>)}</details>}
    {inputContent && <details className="tool-input"><summary>View file content</summary><OutputText text={inputContent} code compact={compact}/></details>}
    {!known && Object.keys(args).length > 0 && <details className="tool-input"><summary>Request</summary><OutputValue value={args} compact={compact}/></details>}
    {!known && Object.keys(metadata).length > 0 && <details className="tool-input"><summary>Result details</summary><OutputValue value={metadata} compact={compact}/></details>}
    {images.map((image, i) => <img className="attachment" key={i} alt="Tool output" src={`data:${image.mimeType};base64,${image.data}`}/>)}
    {output?.details?.exitCode !== undefined && <small>Exit code {output.details.exitCode}</small>}
    {output?.details?.fullOutputPath && <small className="tool-path">Full output: {output.details.fullOutputPath}</small>}
    {!hasText(text) && !patch && result && !images.length && <p className="tool-subtitle">Completed without text output.</p>}
  </section>;
}
