export function orderedIds(saved: string[], live: string[]): string[] {
  const available = new Set(live);
  return [...new Set([...saved.filter(id => available.has(id)), ...live])];
}
export function moveAgent(order: string[], id: string, target?: string, after = false): string[] {
  if (!order.includes(id) || target === id || target !== undefined && !order.includes(target)) return order;
  const next = order.filter(item => item !== id);
  const index = target === undefined ? next.length : next.indexOf(target) + (after ? 1 : 0);
  next.splice(index, 0, id); return next;
}
