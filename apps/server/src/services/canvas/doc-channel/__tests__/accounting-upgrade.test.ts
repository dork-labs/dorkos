/** Upgrade a real foundation database without modifying historical migrations. */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';
import { createDb, runMigrations, sql } from '@dorkos/db';
import { DocChannelStore } from '../store.js';
import { envelopeIdentity } from '../envelope.js';
import { retainDocHistory } from '../retention.js';

it('adds accounting/floors to foundation rows and reconstructs exact Unicode envelope bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'doc-accounting-upgrade-'));
  const oldMigrations = join(directory, 'migrations');
  const source = fileURLToPath(
    new URL('../../../../../../../packages/db/drizzle/', import.meta.url)
  );
  cpSync(source, oldMigrations, { recursive: true });
  const journalPath = join(oldMigrations, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter(
    (entry: { tag: string }) => entry.tag !== '0138_canvas_channel_accounting'
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  const db = createDb(join(directory, 'old.sqlite'));
  try {
    migrate(db, { migrationsFolder: oldMigrations });
    const input = {
      v: 1 as const,
      id: randomUUID(),
      type: 'task.comment',
      payload: { text: '你好 🌍' },
    };
    const identity = envelopeIdentity(input);
    const now = '2026-10-01T12:00:00.000Z';
    db.run(sql`INSERT INTO canvas_doc_channels(document_id,scope,next_doc_seq,created_at,updated_at)
      VALUES('doc-old','session:old',2,${now},${now})`);
    db.run(sql`INSERT INTO canvas_doc_events(document_id,event_id,doc_seq,direction,type,payload,envelope_hash,received_at,provenance)
      VALUES('doc-old',${input.id},1,'upstream',${input.type},${JSON.stringify(input.payload)},${identity.hash},${now},'{}')`);
    runMigrations(db);
    const store = new DocChannelStore(db);
    expect(store.getChannel('doc-old')!.receiptRetentionFloor).toBe(1);
    expect(store.getEvent('doc-old', input.id)!.envelopeBytes).toBe(0);
    retainDocHistory(store, now);
    const upgraded = store.getEvent('doc-old', input.id)!;
    expect(upgraded.envelopeBytes).toBe(identity.bytes);
    expect(upgraded.envelopeHash).toBe(identity.hash);
    expect(upgraded.payload).toEqual(input.payload);
    expect(upgraded.docSeq).toBe(1);
    expect(upgraded.payloadPrunedAt).toBeNull();
    runMigrations(db);
    expect(store.getChannel('doc-old')!.nextDocSeq).toBe(2);
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
