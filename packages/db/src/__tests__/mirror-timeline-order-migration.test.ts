/**
 * Migration 0136 (DOR-2573): every row of a mirrored Community room gets its place in the room's
 * timeline, and every cached Community entry keeps the relation it was sent with. The reads and
 * the import rely on both, so an existing install has to arrive with them filled in.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';

const migrationDir = new URL('../../drizzle/', import.meta.url).pathname;
const TAG = '0136_mirror_timeline_order';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A migrations folder holding every migration before `tag`, or through it with `through`. */
function folder(tag: string, through = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-timeline-order-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'meta'));
  const journal = JSON.parse(readFileSync(join(migrationDir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const target = journal.entries.find((entry) => entry.tag === tag);
  expect(target).toBeDefined();
  const entries = journal.entries.filter((entry) =>
    through ? entry.idx <= target!.idx : entry.idx < target!.idx
  );
  for (const entry of entries) {
    copyFileSync(join(migrationDir, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return dir;
}

const NOW = '2026-09-29T00:00:00.000Z';

function entry(
  sqlite: Database.Database,
  roomId: string,
  seq: number,
  id: string,
  opts: { parent?: string | null; root?: string | null } = {}
) {
  sqlite
    .prepare(
      `INSERT INTO room_entries (room_id, seq, id, author_id, kind, body, cascade_root,
         parent_entry_id, thread_root_entry_id, created_at)
       VALUES (?, ?, ?, 'author', 'post', '{"text":"x"}', ?, ?, ?, ?)`
    )
    .run(roomId, seq, id, id, opts.parent ?? null, opts.root ?? null, NOW);
}

describe('mirrored room timeline order (0136)', () => {
  it('places every row of a mirrored room, and no row of any other room', () => {
    const sqlite = new Database(':memory:');
    try {
      migrate(drizzle(sqlite), { migrationsFolder: folder(TAG) });
      const room = sqlite.prepare(
        `INSERT INTO rooms (id, kind, title, created_at, last_activity_at) VALUES (?, 'channel', ?, ?, ?)`
      );
      room.run('mirror', 'Mirror', NOW, NOW);
      room.run('local', 'Local', NOW, NOW);
      sqlite
        .prepare(
          `INSERT INTO community_room_mirrors (local_room_id, community_ref, remote_room_id,
             owner_author_id, state, authorized_at)
           VALUES ('mirror', 'ref', 'general', 'owner', 'authorized', ?)`
        )
        .run(NOW);
      // Arrival order is not remote order: remote 30 came first, then a local post, then the
      // older history page (remote 10 and a reply to it).
      entry(sqlite, 'mirror', 1, 'L30');
      entry(sqlite, 'mirror', 2, 'local-post');
      entry(sqlite, 'mirror', 3, 'L10');
      entry(sqlite, 'mirror', 4, 'L11', { parent: 'L10', root: 'L10' });
      entry(sqlite, 'local', 1, 'ordinary');
      const cached = sqlite.prepare(
        `INSERT INTO community_mirror_entries (community_ref, remote_room_id, remote_entry_id,
           local_room_id, local_entry_id, remote_seq, entry_json)
         VALUES ('ref', 'general', ?, 'mirror', ?, ?, ?)`
      );
      cached.run(
        'r30',
        'L30',
        30,
        JSON.stringify({ parentEntryId: null, threadRootEntryId: null })
      );
      cached.run(
        'r10',
        'L10',
        10,
        JSON.stringify({ parentEntryId: null, threadRootEntryId: null })
      );
      cached.run(
        'r11',
        'L11',
        11,
        JSON.stringify({ parentEntryId: 'r10', threadRootEntryId: 'r10' })
      );
      // A row cached before entry_json existed has no relation to keep.
      cached.run('r12', 'L12', 12, null);

      migrate(drizzle(sqlite), { migrationsFolder: folder(TAG, true) });

      expect(
        sqlite
          .prepare(
            `SELECT id, timeline_band AS band, timeline_pos AS pos FROM room_entries
             ORDER BY room_id, seq`
          )
          .all()
      ).toEqual([
        { id: 'ordinary', band: null, pos: null },
        { id: 'L30', band: 0, pos: 30 },
        { id: 'local-post', band: 1, pos: 2 },
        { id: 'L10', band: 0, pos: 10 },
        { id: 'L11', band: 0, pos: 11 },
      ]);
      expect(
        sqlite
          .prepare(
            `SELECT remote_entry_id AS id, remote_parent_entry_id AS parent,
               remote_thread_root_entry_id AS root
             FROM community_mirror_entries ORDER BY remote_seq`
          )
          .all()
      ).toEqual([
        { id: 'r10', parent: null, root: null },
        { id: 'r11', parent: 'r10', root: 'r10' },
        { id: 'r12', parent: null, root: null },
        { id: 'r30', parent: null, root: null },
      ]);
      // The placed rows read in timeline order straight from the new index.
      const plan = (
        sqlite
          .prepare(
            `EXPLAIN QUERY PLAN SELECT id FROM room_entries
             WHERE room_id = 'mirror' AND timeline_band IS NOT NULL
             ORDER BY timeline_band DESC, timeline_pos DESC LIMIT 50`
          )
          .all() as { detail: string }[]
      )
        .map((row) => row.detail)
        .join('\n');
      expect(plan).toContain('idx_room_entries_mirror_timeline');
      expect(plan).not.toContain('TEMP B-TREE');
    } finally {
      sqlite.close();
    }
  });
});
