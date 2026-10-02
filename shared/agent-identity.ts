import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { AgentState } from './state.js';

/** Module factories are re-run by /reload; the process object survives it. */
export function attachedAgentId(): string {
  const key = Symbol.for('pi-hub.process-instance');
  const processState = process as unknown as Record<symbol, string>;
  processState[key] ||= randomUUID();
  return `${hostname()}:${process.pid}:${processState[key]}`;
}
/** Never deduplicate by name/cwd, or merge two live processes. */
export function sameAttachedSession(a: AgentState, b: AgentState): boolean {
  if (a.managed || b.managed || !a.host || a.host !== b.host) return false;
  if (a.sessionId && b.sessionId) return a.sessionId === b.sessionId;
  return !!a.sessionFile && a.sessionFile === b.sessionFile;
}
