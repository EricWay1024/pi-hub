/** Local Markdown links become authenticated Hub URLs, never browser file:// URLs. */
export function fileLink(href: string, agentId?: string): string | undefined {
  if (!agentId || !href || href.startsWith('#') || href.startsWith('//')) return;
  let value = href;
  if (/^file:/i.test(value)) {
    try { const url = new URL(value); if (url.hostname && url.hostname !== 'localhost') return; value = url.pathname + url.hash; } catch { return; }
  } else if (/^sandbox:/i.test(value)) value = value.slice('sandbox:'.length);
  else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^(?:[^/:]+\.[^/:]+|README|LICENSE):\d+(?::\d+)?(?:#.*)?$/.test(value)) return;
  const hash = value.indexOf('#'), query = value.indexOf('?');
  const end = Math.min(hash < 0 ? value.length : hash, query < 0 ? value.length : query);
  let pathname: string;
  try { pathname = decodeURIComponent(value.slice(0, end)); } catch { return; }
  if (!pathname || /[\x00-\x1f\x7f]/.test(pathname)) return;
  let fragment = hash >= 0 ? value.slice(hash) : '';
  const location = /:(\d+)(?::\d+)?$/.exec(pathname);
  if (location) { pathname = pathname.slice(0, location.index); fragment ||= '#L' + location[1]; }
  return '/api/files?' + new URLSearchParams({ agentId, path: pathname }) + fragment;
}
