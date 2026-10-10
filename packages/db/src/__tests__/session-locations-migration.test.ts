import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import {
  authors,
  createDb,
  runMigrations,
  sessionLocations,
  sessionNativeBindings,
} from '../index.js';

describe('session location migration', () => {
  it('upgrades an existing audit-era database without skipping the new tables', () => {
    const directory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
    const journal = JSON.parse(
      readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
    ) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const position = journal.entries.findIndex((entry) =>
      /CREATE TABLE [`"]?session_locations[`"]?/u.test(
        readFileSync(path.join(directory, `${entry.tag}.sql`), 'utf8')
      )
    );
    expect(position).toBeGreaterThan(0);
    const earlier = { ...journal, entries: journal.entries.slice(0, position) };
    expect(earlier.entries.some((entry) => entry.tag.endsWith('_audit_events'))).toBe(true);
    expect(journal.entries[position].when).toBeGreaterThan(earlier.entries.at(-1)!.when);
    const root = mkdtempSync(path.join(tmpdir(), 'location-upgrade-'));
    const db = createDb(':memory:');
    try {
      mkdirSync(path.join(root, 'meta'));
      writeFileSync(path.join(root, 'meta/_journal.json'), JSON.stringify(earlier));
      for (const entry of earlier.entries)
        copyFileSync(path.join(directory, `${entry.tag}.sql`), path.join(root, `${entry.tag}.sql`));
      migrate(db, { migrationsFolder: root });
      db.insert(authors)
        .values({
          id: 'existing-owner',
          kind: 'human',
          naturalKey: 'user:existing-owner',
          displayName: 'Owner',
          createdAt: '2026-10-07',
        })
        .run();
      runMigrations(db);
      runMigrations(db);
      expect(db.select().from(authors).get()?.id).toBe('existing-owner');
      db.insert(sessionLocations)
        .values({
          id: 'launch',
          ownerId: 'existing-owner',
          cwd: '/private/work',
          createdAt: '2026-10-07',
        })
        .run();
      db.insert(sessionNativeBindings)
        .values({
          sessionId: 'native',
          runtime: 'codex',
          cwd: '/private/work',
          createdAt: '2026-10-07',
        })
        .run();
      expect(db.select().from(sessionLocations).get()?.id).toBe('launch');
      expect(db.select().from(sessionNativeBindings).get()?.sessionId).toBe('native');
    } finally {
      db.$client.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('persists private caller-scoped locations across opening the database again', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'location-db-'));
    try {
      const file = path.join(root, 'dork.db');
      const db = createDb(file);
      runMigrations(db);
      const row = {
        id: 'opaque',
        ownerId: 'alice',
        cwd: '/private/work',
        createdAt: '2026-10-06T00:00:00Z',
      };
      db.insert(sessionLocations).values(row).run();
      const reopened = createDb(file);
      runMigrations(reopened);
      expect(reopened.select().from(sessionLocations).all()).toEqual([row]);
      expect(() =>
        reopened
          .insert(sessionLocations)
          .values({ ...row, id: 'duplicate' })
          .run()
      ).toThrow(/UNIQUE/);
      reopened
        .insert(sessionLocations)
        .values({ ...row, id: 'other-owner', ownerId: 'bob' })
        .run();
      expect(reopened.select().from(sessionLocations).all()).toHaveLength(2);
      db.$client.close();
      reopened.$client.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
