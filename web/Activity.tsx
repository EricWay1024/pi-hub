import type { RecordData } from '../shared/state';
import { activityPresentation, hasText } from '../shared/output';
import { OutputText, OutputValue, ToolCard } from './ToolOutput';
export function ToolActivity({ tools }: { tools: Record<string, RecordData> }) {
  return <>{Object.values(tools).reverse().map(tool => <ToolCard key={tool.toolCallId} name={tool.toolName || 'tool'} args={tool.args} result={tool.result} execution={tool} compact/>)}</>;
}
export function ActivityFeed({ events }: { events: RecordData[] }) {
  return <>{[...events].reverse().map((event, i) => {
    const view = activityPresentation(event);
    const metadata = Object.fromEntries(Object.entries(view.data).filter(([key]) => !['type','time','timestamp','ts','agent','summary','message','text','errorMessage','finalError','error','reason'].includes(key)));
    return <section className={'activity-card ' + view.status} key={`${event.time}-${i}`}>
      <div className="activity-card-heading"><strong>{view.agent ? `${view.agent} · ${view.title}` : view.title}</strong><time>{event.time ? new Date(event.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</time></div>
      {hasText(view.summary) && <OutputText text={view.summary} code={event.type === 'diagnostic'} compact/>}
      {Object.keys(metadata).length > 0 && <details className="tool-input"><summary>Details</summary><OutputValue value={metadata} compact/></details>}
    </section>;
  })}</>;
}
