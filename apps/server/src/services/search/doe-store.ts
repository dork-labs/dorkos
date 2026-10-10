/** Read throwaway SQLite copies of DorkOS metadata and main-scope model prose. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { projectDoeMessages, type DoeMessageRow } from './projections/doe.js';
import type { ContainerReader, RowContainer } from './types.js';

/** Absent stores suppress pruning; an existing empty store proves removal. */
export function openDoeSnapshot(directory: string): (ContainerReader & { close(): void }) | null {
  const names = ['sessions.sqlite', 'models.sqlite'];
  if (names.some((name) => !fs.existsSync(path.join(directory, name)))) return null;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-doe-search-'));
  const databases: Database.Database[] = [];
  const close = () => {
    for (const db of databases) db.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  };
  try {
    for (const name of names) {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.copyFileSync(path.join(directory, name + suffix), path.join(temporary, name + suffix));
        } catch (error) {
          if (suffix === '' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const db = new Database(path.join(temporary, name), { readonly: true });
      db.pragma('query_only = ON');
      databases.push(db);
    }
    const [metadata, models] = databases;
    const rows = metadata!.prepare('SELECT id, record FROM sessions ORDER BY id').all() as {
      id: string;
      record: string;
    }[];
    const containers: RowContainer[] = rows.map((row) => {
      const record = JSON.parse(row.record) as { session: { cwd?: string } };
      const count = models!
        .prepare(
          "SELECT COALESCE(MAX(seq),0) AS maximum FROM messages WHERE session_id=? AND scope='main'"
        )
        .get(row.id) as { maximum: number };
      return {
        originKey: row.id,
        containerPath: record.session.cwd ?? null,
        maxOrdinal: count.maximum,
      };
    });
    const ids = new Set(containers.map((container) => container.originKey));
    return {
      close,
      listContainers: () => containers,
      readSince: (id, ordinal) =>
        projectDoeMessages(
          id,
          ids.has(id)
            ? (models!
                .prepare(
                  "SELECT seq,payload FROM messages WHERE session_id=? AND scope='main' AND seq>? ORDER BY seq"
                )
                .all(id, ordinal) as DoeMessageRow[])
            : []
        ),
    };
  } catch (error) {
    close();
    throw error;
  }
}
