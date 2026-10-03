export interface SlashCommand {
  name: string; description: string; source: 'web' | 'extension' | 'prompt' | 'skill' | 'terminal';
  argumentHint?: string; unavailable?: boolean;
}
export const WEB_COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'Show commands and keyboard shortcuts', source: 'web' },
  { name: 'model', description: 'Choose a model', argumentHint: '[provider/model]', source: 'web' },
  { name: 'thinking', description: 'Change reasoning level', argumentHint: '[off|minimal|low|medium|high|xhigh|max]', source: 'web' },
  { name: 'name', description: 'Rename this conversation', argumentHint: '[name]', source: 'web' },
  { name: 'compact', description: 'Compact conversation context', argumentHint: '[instructions]', source: 'web' },
  { name: 'abort', description: 'Abort the current operation', source: 'web' },
  { name: 'copy', description: 'Copy the latest assistant reply', source: 'web' },
  { name: 'export', description: 'Download the displayed transcript as JSON', source: 'web' },
  { name: 'session', description: 'Open agent activity and session details', source: 'web' },
  { name: 'settings', description: 'Open model and thinking controls', source: 'web' },
];
const TERMINAL_COMMANDS: SlashCommand[] = [
  { name: 'reload', description: 'Reload Pi resources in the CLI', source: 'terminal', unavailable: true },
  { name: 'login', description: 'Configure provider authentication in the CLI', source: 'terminal', unavailable: true },
  { name: 'logout', description: 'Remove provider authentication in the CLI', source: 'terminal', unavailable: true },
  { name: 'tree', description: 'Navigate branches in the CLI', source: 'terminal', unavailable: true },
  { name: 'resume', description: 'Choose a saved session in the CLI', source: 'terminal', unavailable: true },
  { name: 'new', description: 'Start a fresh CLI session; use New agent in the web instead', source: 'terminal', unavailable: true },
  { name: 'fork', description: 'Fork from an earlier message in the CLI', source: 'terminal', unavailable: true },
  { name: 'clone', description: 'Clone the current session in the CLI', source: 'terminal', unavailable: true },
  { name: 'quit', description: 'Quit Pi in the CLI; use Stop agent for managed agents', source: 'terminal', unavailable: true },
];
export function commandList(discovered: unknown, engine: 'pi' | 'codex' = 'pi'): SlashCommand[] {
  const list = new Map([...WEB_COMMANDS, ...(engine === 'codex' ? [] : TERMINAL_COMMANDS)].map(c => [c.name, c]));
  if (Array.isArray(discovered)) for (const c of discovered) {
    if (typeof c?.name !== 'string' || !c.name || /\s/.test(c.name) || c.name.startsWith('/')) continue;
    if (!['extension', 'prompt', 'skill'].includes(c.source)) continue;
    // Built-ins belong to the host; do not silently override web controls.
    if (list.has(c.name)) continue;
    list.set(c.name, { name: c.name, description: typeof c.description === 'string' ? c.description : '', source: c.source });
  }
  return [...list.values()];
}
export function slashQuery(draft: string, cursor = draft.length): string | null {
  if (cursor !== draft.length) return null;
  const match = /^\/([^\s]*)$/.exec(draft);
  return match ? match[1].toLowerCase() : null;
}
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return commands.filter(c => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
    .sort((a, b) => Number(!!a.unavailable) - Number(!!b.unavailable)
      || Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q))
      || a.name.localeCompare(b.name));
}
export function parseSlashCommand(draft: string): { name: string; args: string } | null {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(draft.trim());
  return match ? { name: match[1], args: (match[2] || '').trim() } : null;
}
