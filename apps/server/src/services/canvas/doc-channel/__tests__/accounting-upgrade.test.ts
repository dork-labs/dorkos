/** Upgrade a real foundation database without modifying historical migrations. */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it, vi } from 'vitest';
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
  const accountingIndex = journal.entries.findIndex(
    (entry: { tag: string }) => entry.tag === '0138_canvas_channel_accounting'
  );
  expect(accountingIndex).toBeGreaterThan(0);
  // A historical database cannot have later migrations applied while skipping this one.
  journal.entries = journal.entries.slice(0, accountingIndex);
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

// The paid SDK process alone is replaced. Authority comes from the real original constructor/FILE DB.
const nativeRetentionSdk = vi.hoisted(() => ({
  options: [] as unknown[],
  prompts: [] as unknown[],
  parked: true,
  release: undefined as (() => void) | undefined,
}));
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: unknown) {
      nativeRetentionSdk.options.push(options);
    }
    startThread() {
      return {
        id: 'native-retention-source',
        runStreamed: async (prompt: unknown) => {
          nativeRetentionSdk.prompts.push(prompt);
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'native-retention-source' };
              if (nativeRetentionSdk.parked)
                await new Promise<void>((resolve) => {
                  nativeRetentionSdk.release = resolve;
                });
              yield {
                type: 'turn.completed',
                usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
              };
            })(),
          };
        },
      };
    }
    resumeThread() {
      return this.startThread();
    }
  },
}));
import { nativeCommittedCodexRoomFixture } from '../writes/__tests__/authority-fixtures.js';
function originalNativeRetentionSource(disposition: 'settled' | 'unpulled' = 'settled') {
  nativeRetentionSdk.options.length = 0;
  nativeRetentionSdk.prompts.length = 0;
  nativeRetentionSdk.parked = true;
  nativeRetentionSdk.release = undefined;
  return nativeCommittedCodexRoomFixture(
    {
      options: nativeRetentionSdk.options,
      prompts: nativeRetentionSdk.prompts,
      releaseProducer: () => nativeRetentionSdk.release?.(),
      completeFutureTurns: () => {
        nativeRetentionSdk.parked = false;
      },
    },
    disposition
  );
}

it.each(['foundation bytes', 'corrupt raw JSON'] as const)(
  'backfills real native-linked history without trusting a public event DTO: %s',
  async (scenario) => {
    const h = await originalNativeRetentionSource();
    let publicGetter: ReturnType<typeof vi.spyOn> | undefined;
    let failed = false,
      first: unknown;
    try {
      const linked = h.http.channels.getEvent(h.documentId, h.input.id)!;
      const unrelated = {
        v: 1 as const,
        id: randomUUID(),
        type: 'md.comment',
        payload: { text: 'ordinary Unicode 🦉 東京' },
      };
      const identity = envelopeIdentity(unrelated);
      h.http.channels.appendEvent({
        documentId: h.documentId,
        eventId: unrelated.id,
        direction: 'upstream',
        type: unrelated.type,
        payload: unrelated.payload,
        envelopeHash: identity.hash,
        envelopeBytes: 0,
        receivedAt: new Date().toISOString(),
        provenance: {},
      });
      if (scenario === 'corrupt raw JSON')
        h.db.run(
          sql`UPDATE canvas_doc_events SET payload=${'{not-json'} WHERE document_id=${h.documentId} AND event_id=${unrelated.id}`
        );
      publicGetter = vi.spyOn(h.http.channels, 'getEvent').mockImplementation(() => {
        throw new Error('Mutable public event getter consulted.');
      });
      if (scenario === 'corrupt raw JSON') {
        expect(() => retainDocHistory(h.http.channels, new Date().toISOString())).toThrow();
        expect(
          h.db.get<{ bytes: number }>(
            sql`SELECT envelope_bytes AS bytes FROM canvas_doc_events WHERE document_id=${h.documentId} AND event_id=${unrelated.id}`
          )
        ).toEqual({ bytes: 0 });
      } else {
        retainDocHistory(h.http.channels, new Date().toISOString());
        expect(
          h.db.get<{ bytes: number }>(
            sql`SELECT envelope_bytes AS bytes FROM canvas_doc_events WHERE document_id=${h.documentId} AND event_id=${unrelated.id}`
          )
        ).toEqual({ bytes: identity.bytes });
      }
      expect(publicGetter).not.toHaveBeenCalled();
      publicGetter.mockRestore();
      expect(h.http.channels.getEvent(h.documentId, h.input.id)).toEqual(linked);
      expect(h.admission.status).toBe('settled');
    } catch (cause) {
      failed = true;
      first = cause;
    } finally {
      try {
        publicGetter?.mockRestore();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      try {
        await h.cleanup();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    }
    if (failed) throw first;
  }
);

it('closes the actual native fixture when post-acquisition setup throws undefined', async () => {
  const h = await originalNativeRetentionSource();
  let failed = false,
    first: unknown,
    attempted = false;
  const setup = async () => {
    // Join this scope to its captured cleanup before returning or reporting failure.
    const drainOriginalCleanup = async () => {
      attempted = true;
      try {
        await h.cleanup();
        throw new Error('secondary cleanup after genuine closure');
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    };
    try {
      throw undefined;
    } catch (cause) {
      failed = true;
      first = cause;
    } finally {
      await drainOriginalCleanup();
    }
    if (failed) throw first;
  };
  await expect(setup()).rejects.toBeUndefined();
  expect(attempted).toBe(true);
  expect(h.db.$client.open).toBe(false);
  const fs = await import('node:fs/promises');
  await expect(fs.stat(h.dir)).rejects.toMatchObject({ code: 'ENOENT' });
});
