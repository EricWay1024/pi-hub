import { useEffect, useRef, useState } from 'react';
import { agentStatus, type AgentState, type RecordData } from '../shared/state';

const count = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export function UsageMeter({ agent, connected, request }: { agent: AgentState; connected: boolean; request: () => Promise<RecordData> }) {
  const latestRequest = useRef(request); latestRequest.current = request;
  const [stats, setStats] = useState<RecordData>();
  const [error, setError] = useState('');
  useEffect(() => { setStats(undefined); setError(''); }, [agent.id, agent.sessionId, agent.sessionFile]);
  useEffect(() => {
    if (!connected || !agent.online) return;
    let stopped = false, inFlight = false, unsupported = false;
    async function refresh() {
      if (stopped || inFlight || unsupported) return;
      inFlight = true;
      try {
        const response = await latestRequest.current();
        if (!stopped && (!agent.sessionId || !response.data?.sessionId || agent.sessionId === response.data.sessionId)) { setStats(response.data); setError(''); }
      } catch (e) {
        if (!stopped) {
          unsupported = /Unsupported|Unknown command/i.test((e as Error).message);
          setError(unsupported && !agent.managed ? 'Run /reload in Pi to enable usage' : 'Usage temporarily unavailable');
        }
      } finally { inFlight = false; }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 15_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [agent.id, agent.sessionId, agent.sessionFile, agent.busy, agent.compaction?.startedAt, agent.model, agent.totalMessageCount, agent.online, agent.managed, connected]);
  const stale = !connected || !agent.online || !!error;
  return <div className={'usage-meter' + (stale ? ' stale' : '')} aria-label="Context usage">
    <ContextIndicator context={stats?.contextUsage} compacting={agent.online && agent.compaction ? agentStatus(agent).toLowerCase() : undefined} notice={error || (stale ? 'Offline · last reported' : undefined)}/>
  </div>;
}

export function ContextIndicator({ context, compacting, notice }: { context?: RecordData; compacting?: string; notice?: string }) {
  const [details, setDetails] = useState(false);
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const known = !compacting && valid(context?.tokens) && valid(context?.contextWindow) && context.contextWindow > 0;
  const percent = known ? context!.tokens / context!.contextWindow * 100 : undefined;
  const level = percent === undefined ? 'unknown' : percent >= 95 ? 'critical' : percent >= 85 ? 'high' : 'normal';
  const label = compacting || (percent === undefined ? 'unknown' : `${percent.toFixed(1)}%`);
  const tokens = known ? `${count.format(context!.tokens)} / ${count.format(context!.contextWindow)} tokens (${context!.tokens.toLocaleString('en')} / ${context!.contextWindow.toLocaleString('en')})`
    : valid(context?.contextWindow) && context.contextWindow > 0 ? `Usage unknown / ${count.format(context.contextWindow)} tokens` : 'Usage not yet available';
  const description = `${notice ? notice + '. ' : ''}${compacting ? compacting + '. ' : ''}${tokens}. Estimated current context, not cumulative session tokens.`;
  return <span className={'context-indicator ' + level}>
    <button type="button" className="context-button" aria-label={`Context usage: ${label}.${notice ? ' ' + notice + '.' : ''} Tap for token counts`} aria-expanded={details} title={description} onClick={() => setDetails(!details)}>
      <span>Context</span><span className="context-battery" role="progressbar" aria-label="Estimated context usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === undefined ? undefined : Math.min(100, percent)} aria-valuetext={label}>
        <span className="context-battery-track"><span className="context-battery-charge" style={{ width: percent === undefined ? '100%' : `${Math.min(100, percent)}%` }}/></span>
      </span><span>{label}</span>{notice && <span aria-hidden="true">!</span>}
    </button>
    {details && <span className="context-token-details">{notice ? notice + '. ' : ''}{tokens}</span>}
  </span>;
}
