import type { RecordData } from './state.js';

/** Match Pi's session accounting: all entries, including abandoned branches and summaries. */
export function sessionUsage(entries: RecordData[]) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  for (const entry of entries) {
    const usage = ['usage', 'compaction', 'branch_summary'].includes(entry.type) ? entry.usage
      : entry.type === 'message' && ['assistant', 'toolResult'].includes(entry.message?.role) ? entry.message.usage : undefined;
    if (!usage) continue;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) tokens[key] += number(usage[key]);
    cost += number(usage.cost?.total);
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return { tokens, cost };
}
