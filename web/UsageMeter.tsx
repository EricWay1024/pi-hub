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
  const context = stats?.contextUsage;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const knownContext = valid(context?.tokens) && valid(context?.contextWindow) && context.contextWindow > 0;
  const percent = knownContext ? context.tokens / context.contextWindow * 100 : undefined;
  const cost = valid(stats?.cost) ? stats.cost : undefined;
  const stale = !connected || !agent.online || !!error;
  return <div className={'usage-meter' + (stale ? ' stale' : '')} aria-label="Context usage and estimated session cost">
    <span className={percent !== undefined && percent >= 85 ? 'usage-high' : ''} title="Estimated current context, not cumulative session tokens. Unknown after compaction until the next model response.">Context {agent.online && agent.compaction ? agentStatus(agent).toLowerCase() : knownContext ? `${percent!.toFixed(1)}% · ${count.format(context.tokens)} / ${count.format(context.contextWindow)}` : valid(context?.contextWindow) && context.contextWindow > 0 ? `unknown / ${count.format(context.contextWindow)}` : '—'}</span>
    <span title={`Pi-reported cumulative session estimate in USD, including recorded summaries and tool usage. Not an actual provider bill.${stats?.tokens ? ` Tokens: ${stats.tokens.input} input, ${stats.tokens.output} output, ${stats.tokens.cacheRead} cache read, ${stats.tokens.cacheWrite} cache write.` : ''}`}>Session estimate {cost === undefined ? '—' : cost > 0 && cost < 0.0001 ? '< $0.0001' : `$${cost.toFixed(4)}`} USD</span>
    {(error || stale) && <span className="usage-note">{error || 'Offline · last reported'}</span>}
  </div>;
}
