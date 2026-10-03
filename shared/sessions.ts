export type SessionEngine = 'pi' | 'codex';
export type SavedSession = {
  key: string; engine: SessionEngine; id: string; cwd: string; name: string; preview: string;
  createdAt: number; updatedAt: number; messageCount?: number;
};
export type SessionPage = { sessions: SavedSession[]; cursor?: string; warnings: string[]; limited: boolean };
