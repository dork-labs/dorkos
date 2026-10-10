import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createDb, runMigrations, sessionNativeBindings } from '../index.js';

describe('native session identity migration', () => {
  it('persists actual directory and private source separately from agent provenance', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'native-binding-db-'));
    try {
      const db = createDb(path.join(root, 'dork.db'));
      runMigrations(db);
      const row = {
        sessionId: 'native',
        runtime: 'codex',
        cwd: '/actual/worktree',
        account: '/private/codex-home',
        createdAt: '2026-10-06',
      };
      db.insert(sessionNativeBindings).values(row).run();
      expect(db.select().from(sessionNativeBindings).all()).toEqual([row]);
      db.$client.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
