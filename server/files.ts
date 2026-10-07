import type { ServerResponse } from 'node:http';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const types: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const textExtensions = new Set(['.txt', '.md', '.markdown', '.tex', '.typ', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yaml', '.yml', '.toml', '.xml', '.html', '.htm', '.svg', '.css', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sh', '.bash', '.rs', '.go', '.c', '.h', '.cpp', '.hpp', '.java', '.sql', '.diff', '.patch', '.r', '.jl', '.ipynb']);
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Read only an existing regular file in projectsRoot. HTML/SVG/source never executes. */
export async function serveLocalFile(root: string, cwd: string, requested: string, res: ServerResponse, download = false, agentId = '') {
  if (!requested || requested.length > 4096 || /[\x00-\x1f\x7f]/.test(requested)) throw new Error('Invalid file path');
  const base = await realpath(root), directory = await realpath(cwd);
  if (!inside(base, directory)) throw new Error('Agent workspace is outside projectsRoot');
  const target = path.resolve(directory, requested.startsWith('~/') ? path.join(homedir(), requested.slice(2)) : requested);
  let file: string;
  try { file = await realpath(target); } catch { throw new Error('Local file not found; it may have moved or existed only in a remote sandbox'); }
  if (!inside(base, file)) throw new Error('Local file must be inside projectsRoot');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat(), current = await realpath(file), currentInfo = await stat(current);
    if (!inside(base, current) || currentInfo.ino !== info.ino || currentInfo.dev !== info.dev) throw new Error('File changed while opening; try again');
    if (!info.isFile()) throw new Error('This link points to a directory or non-regular file');
    if (info.size > 50 * 1024 * 1024) throw new Error('File exceeds the 50 MB browser limit');
    const extension = path.extname(file).toLowerCase(), name = path.basename(file);
    const buffer = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset > info.size) throw new Error('File grew while opening; try again');
    const raw = buffer.subarray(0, offset);
    // Untrusted documents cannot access Hub cookies/API, run scripts or load resources.
    const policy = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    if (!download && raw.length <= 2 * 1024 * 1024 && (textExtensions.has(extension) || ['README', 'LICENSE', 'Makefile', 'Dockerfile'].includes(name))) {
      const source = raw.toString('utf8'), lines = source.split('\n'), truncated = lines.length > 20_000;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(name)}</title><style>body{font:14px system-ui;margin:20px;color:#253630;background:#fafbf5}pre{font:13px ui-monospace,monospace;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.line{display:block;scroll-margin-top:20px}.line:target{background:#fff2bd}h1{font-size:18px}a{color:#287654}</style></head><body><h1>${escape(name)}</h1><p>Read-only local file · <a href="${escape('/api/files?' + new URLSearchParams({ agentId, path: requested, download: '1' }))}">Download</a></p>${truncated ? '<p>Preview limited to 20,000 lines. Download for the full file.</p>' : ''}<pre>${lines.slice(0, 20_000).map((line, i) => `<span class="line" id="L${i + 1}">${escape(line) || '\u200b'}</span>`).join('')}</pre></body></html>`);
    } else {
      res.setHeader('Content-Security-Policy', 'sandbox; ' + policy);
      const type = download ? 'application/octet-stream' : types[extension] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `${download || !types[extension] ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}` }); res.end(raw);
    }
  } finally { await handle.close(); }
}
