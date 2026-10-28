const KEY = 'pi-hub.selected-agent';
type SelectionStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function loadSelectedAgent(storage?: SelectionStorage): string {
  try { return (storage ?? localStorage).getItem(KEY) || ''; }
  catch { return ''; }
}

export function rememberSelectedAgent(id: string, storage?: SelectionStorage) {
  // Empty inventories during reconnect must not erase the last useful choice.
  if (!id) return;
  try { (storage ?? localStorage).setItem(KEY, id); }
  catch { /* Storage-disabled browsers still support selection this visit. */ }
}

export function availableSelection(selected: string, agents: { id: string }[], replacements?: Record<string, string>): string {
  if (agents.some(agent => agent.id === selected)) return selected;
  const replacement = replacements?.[selected];
  if (replacement && agents.some(agent => agent.id === replacement)) return replacement;
  return agents[0]?.id || '';
}
