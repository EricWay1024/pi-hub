import { createHash, randomUUID } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { emptyAgent } from '../shared/state.js';
import type { SavedSession, SessionEngine, SessionPage } from '../shared/sessions.js';
import { CodexAgent } from './codex.js';

type Choice = SavedSession & { file?: string };
type Snapshot = { id: string; scope: string; expires: number; choices: Choice[]; warnings: string[]; limited: boolean };
const PAGE_SIZE = 50, MAX_SESSIONS = 2000, LIFETIME = 20 * 60_000;
const text = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, limit) : '';
const directoryPath = (cwd: string, dir?: string) => dir ? path.resolve(cwd, dir.startsWith('~/') ? path.join(homedir(), dir.slice(2)) : dir) : undefined;

/** Authenticated metadata only. Opaque choices, not browser-provided session-file paths. */
export class SessionLibrary {
  private snapshots = new Map<string, Snapshot>();
  private loading = new Map<string, Promise<Snapshot>>();
  private readers = new Set<CodexAgent>();
  private closed = false;
  constructor(private root: string, private validateDirectory: (cwd: string) => Promise<string>) {}
  private async pi(cwd?: string): Promise<Choice[]> {
    const { SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
    const sessionDir = (directory: string) => directoryPath(directory, process.env.PI_CODING_AGENT_SESSION_DIR || SettingsManager.create(directory).getSessionDir());
    const signal = AbortSignal.timeout(15_000);
    const infos = cwd ? await SessionManager.list(cwd, sessionDir(cwd), undefined, signal) : await SessionManager.listAll(sessionDir(this.root), undefined, signal);
    // Also discover first-level workspaces with a project-specific sessionDir.
    if (!cwd) {
      const globalDir = sessionDir(this.root);
      for (const entry of (await readdir(this.root, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith('.')).slice(0, 100)) {
        const workspace = await this.validateDirectory(path.join(this.root, entry.name)), dir = sessionDir(workspace);
        if (dir && dir !== globalDir) infos.push(...await SessionManager.list(workspace, dir, undefined, signal));
      }
    }
    const seen = new Set<string>(), choices: Choice[] = [];
    for (const info of infos) {
      if (!info.cwd) continue;
      try {
        const directory = await this.validateDirectory(info.cwd);
        if (cwd && directory !== cwd) continue;
        const file = await realpath(info.path);
        if (seen.has(file)) continue; seen.add(file);
        choices.push({ key: randomUUID(), engine: 'pi', id: info.id, file, cwd: directory, name: text(info.name, 100) || text(info.firstMessage, 100) || 'Unnamed Pi session', preview: text(info.firstMessage, 300), createdAt: info.created.getTime(), updatedAt: info.modified.getTime(), messageCount: info.messageCount });
      } catch { /* Deleted, inaccessible or out-of-scope workspace/session. */ }
    }
    return choices;
  }
  private async codex(cwd?: string): Promise<{ choices: Choice[]; limited: boolean }> {
    const state = emptyAgent('catalog'); state.cwd = cwd || this.root;
    if (this.readers.size >= 3) throw new Error('Codex session discovery is busy; try again shortly');
    const reader = new CodexAgent(state, () => {}); this.readers.add(reader);
    try {
      await reader.initialize();
      const choices: Choice[] = []; let cursor: string | undefined; const seen = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const result = await reader.savedThreads(cursor, cwd);
        for (const thread of result.data || []) {
          if (typeof thread.id !== 'string' || thread.ephemeral || !thread.cwd) continue;
          try {
            const directory = await this.validateDirectory(thread.cwd);
            if (cwd && directory !== cwd) continue;
            choices.push({ key: randomUUID(), engine: 'codex', id: thread.id, cwd: directory, name: text(thread.name, 100) || text(thread.preview, 100) || 'Unnamed Codex session', preview: text(thread.preview, 300), createdAt: thread.createdAt * 1000, updatedAt: thread.updatedAt * 1000 });
          } catch { /* Workspace outside the allowed root or no longer exists. */ }
        }
        cursor = result.nextCursor || undefined;
        if (!cursor) return { choices, limited: false };
        if (seen.has(cursor)) throw new Error('Repeated Codex catalog cursor'); seen.add(cursor);
      }
      return { choices, limited: true };
    } finally { reader.stop(); this.readers.delete(reader); }
  }
  private prune() {
    for (const [id, snapshot] of this.snapshots) if (snapshot.expires <= Date.now()) this.snapshots.delete(id);
  }
  async page(engine: SessionEngine | 'all', directory?: string, cursor?: string, query = '', refresh = false): Promise<SessionPage> {
    if (this.closed) throw new Error('Hub shutting down');
    this.prune();
    const cwd = directory ? await this.validateDirectory(directory) : undefined, scope = `${engine}:${cwd || ''}`;
    const search = query.trim().toLowerCase(), queryKey = createHash('sha256').update(search).digest('hex').slice(0, 12);
    let snapshot: Snapshot | undefined, offset = 0;
    if (cursor) {
      const match = /^([a-f0-9-]{36}):(\d{1,5}):([a-f0-9]{12})$/.exec(cursor);
      snapshot = match ? this.snapshots.get(match[1]) : undefined;
      if (!snapshot || snapshot.scope !== scope || match![3] !== queryKey) throw new Error('Session list expired or changed. Refresh the list.');
      offset = Number(match![2]);
      if (offset > snapshot.choices.length) throw new Error('Invalid session cursor');
    } else {
      snapshot = refresh ? undefined : [...this.snapshots.values()].reverse().find(s => s.scope === scope && s.expires > Date.now() + LIFETIME - 30_000);
      if (!snapshot) {
        let pending = this.loading.get(scope);
        if (!pending) {
          if (this.loading.size >= 2) throw new Error('Session discovery is busy; try again shortly');
          pending = this.discover(scope, engine, cwd); this.loading.set(scope, pending);
          void pending.finally(() => this.loading.delete(scope)).catch(() => {});
        }
        snapshot = await pending;
      }
    }
    const choices = snapshot.choices.filter(c => !search || `${c.name}\n${c.preview}\n${c.cwd}\n${c.id}`.toLowerCase().includes(search));
    if (offset > choices.length) throw new Error('Invalid session cursor');
    const end = Math.min(offset + PAGE_SIZE, choices.length);
    return { sessions: choices.slice(offset, end).map(({ file, ...session }) => session), cursor: end < choices.length ? `${snapshot.id}:${end}:${queryKey}` : undefined, warnings: snapshot.warnings, limited: snapshot.limited };
  }
  private async discover(scope: string, engine: SessionEngine | 'all', cwd?: string): Promise<Snapshot> {
    const warnings: string[] = []; let limited = false;
    const [pi, codex] = await Promise.all([
      engine === 'codex' ? [] : this.pi(cwd).catch(() => { warnings.push('Pi sessions could not be loaded. Check local session storage.'); return []; }),
      engine === 'pi' ? { choices: [], limited: false } : this.codex(cwd).catch(() => { warnings.push('Codex sessions unavailable. Check the CLI installation and local configuration.'); return { choices: [], limited: false }; }),
    ]);
    if (this.closed) throw new Error('Hub shutting down');
    const choices = [...pi, ...codex.choices].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    limited = codex.limited || choices.length > MAX_SESSIONS;
    const snapshot = { id: randomUUID(), scope, expires: Date.now() + LIFETIME, choices: choices.slice(0, MAX_SESSIONS), warnings, limited };
    while (this.snapshots.size >= 8) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(snapshot.id, snapshot); return snapshot;
  }
  choice(key: string): Choice {
    this.prune();
    for (const snapshot of this.snapshots.values()) { const choice = snapshot.choices.find(c => c.key === key); if (choice) return choice; }
    throw new Error('Session choice expired or unknown. Refresh the list.');
  }
  async validate(choice: Choice) {
    const directory = await this.validateDirectory(choice.cwd);
    if (directory !== choice.cwd) throw new Error('Session workspace changed. Refresh the list.');
    if (choice.engine === 'pi') {
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      const infos = await SessionManager.list(directory, path.dirname(choice.file!));
      const info = infos.find(i => i.id === choice.id && path.resolve(i.path) === choice.file);
      if (!info || await this.validateDirectory(info.cwd) !== directory) throw new Error('Saved session changed or was deleted. Refresh the list.');
    } else {
      const state = emptyAgent('catalog'); state.cwd = directory;
      if (this.readers.size >= 3) throw new Error('Codex session discovery is busy; try again shortly');
      const reader = new CodexAgent(state, () => {}); this.readers.add(reader);
      try {
        await reader.initialize(); const thread = await reader.readThread(choice.id);
        if (thread.id !== choice.id || await this.validateDirectory(thread.cwd) !== directory) throw new Error('Saved Codex workspace changed. Refresh the list.');
        if (thread.status?.type === 'active') throw new Error('This Codex thread is active elsewhere. Finish or close it there before resuming.');
      } finally { reader.stop(); this.readers.delete(reader); }
    }
  }
  close() { this.closed = true; for (const reader of this.readers) reader.stop(); this.snapshots.clear(); }
}
