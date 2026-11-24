import { trackColdImport, fixture } from './harness.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import { loadCeilingMs } from '@dorkos/shared/test-budget';
import { describe, expect, it } from 'vitest';
import { canvasDocWriteIntents, eq } from '@dorkos/db';
import { prepareCheckboxBytes, rawByteHash } from '../../checkbox-bytes.js';
import { observedCheckboxIntent } from '../../checkbox-evidence.js';

const canvasEntry = new URL('../../../../canvas-service.ts', import.meta.url).href;
const roomCanvasEntry = new URL(
  '../../../../../rooms/canvas/room-canvas-service.ts',
  import.meta.url
).href;
const importEntries = [
  new URL('../../../store.ts', import.meta.url).href,
  new URL('../../authority.ts', import.meta.url).href,
  new URL('../../authority-policy.ts', import.meta.url).href,
  new URL('../../reservation-bridge.ts', import.meta.url).href,
  new URL('../../reservation-policy-census.ts', import.meta.url).href,
  canvasEntry,
  roomCanvasEntry,
];
// Each case starts a fresh node + tsx process and transpiles the whole canvas
// graph cold, which a loaded machine stretches past the 5s default (DOR-2021).
// The cap only matters if LOAD_SCALE_MAX rises.
const COLD_IMPORT_TIMEOUT_MS = Math.min(60_000, loadCeilingMs(10_000));
it.each([importEntries[0]!, canvasEntry])(
  'cold-loads the declarations-only cycle starting at %s',
  { timeout: COLD_IMPORT_TIMEOUT_MS },
  async (first) => {
    const program =
      `const first = await import(${JSON.stringify(first)});
` +
      importEntries
        .filter((entry) => entry !== first)
        .map((entry) => `await import(${JSON.stringify(entry)});`)
        .join('\n') +
      `\nconst canvas = await import(${JSON.stringify(canvasEntry)});
const roomCanvas = await import(${JSON.stringify(roomCanvasEntry)});
if (canvas.MAX_CANVAS_DOCUMENTS !== 12 || roomCanvas.MAX_ROOM_CANVAS_DOCUMENTS !== 12)
  throw new Error('Uninitialized original canvas capacity');
if (!Object.keys(first).length) throw new Error('Empty entry'); console.log('cold-import-complete');`;
    const argv = ['--import', 'tsx', '--input-type=module', '-e', program];
    const invokedAt = new Date().toISOString(),
      started = performance.now();
    const running = promisify(execFile)(process.execPath, argv, { cwd: process.cwd() });
    void running.catch(() => {});
    const owned = trackColdImport(running.child, [process.execPath, ...argv], invokedAt, started);
    const { stdout, stderr } = await running;
    await owned.closed;
    expect(stdout).toContain('cold-import-complete');
    expect(stderr).not.toContain('before initialization');
  }
);

describe('prepared original scope obligations', () => {
  it('rolls back a valid prepared-row update before the genuine A scope exits', async () => {
    const h = await fixture();
    const channel = h.http.channels.getChannel(h.input.documentId)!;
    const bytes = await fs.readFile(h.path),
      identity = await fs.stat(h.path, { bigint: true });
    const snapshot = await h.authority.refreshCurrent(h.input, h.actor, h.approved);
    let reached = false;
    expect(() =>
      h.authority.transaction((tx) => {
        h.bridge.insertPreparedInTransaction(
          {
            candidate: h.prepared,
            liveSubject: { kind: 'live', request: h.input, actor: h.actor, approved: h.approved },
            freshSnapshot: snapshot,
          },
          tx
        );
        tx.update(canvasDocWriteIntents)
          .set({ updatedAt: '2099-01-01T00:00:00.000Z' })
          .where(eq(canvasDocWriteIntents.intentId, h.prepared.intentId))
          .run();
        expect(h.http.channels.getWriteIntent(h.prepared.intentId, tx)?.updatedAt).toBe(
          '2099-01-01T00:00:00.000Z'
        );
        reached = true;
      })
    ).toThrow('Checkbox original transition row changed.');
    expect(reached).toBe(true);
    expect(h.http.channels.getWriteIntent(h.prepared.intentId)).toBeUndefined();
    expect(h.http.channels.getChannel(h.input.documentId)).toEqual(channel);
    expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_events').get()).toEqual({
      n: 0,
    });
    expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_deliveries').get()).toEqual({
      n: 0,
    });
    expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_batches').get()).toEqual({
      n: 0,
    });
    expect(await fs.readFile(h.path)).toEqual(bytes);
    const after = await fs.stat(h.path, { bigint: true });
    expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
  });

  it('refuses trigger-altered prepared evidence before returning from insert', async () => {
    const h = await fixture();
    const channel = h.http.channels.getChannel(h.input.documentId)!;
    const bytes = await fs.readFile(h.path),
      identity = await fs.stat(h.path, { bigint: true });
    const snapshot = await h.authority.refreshCurrent(h.input, h.actor, h.approved);
    h.db.$client.exec(`CREATE TEMP TRIGGER alter_prepared_after_insert
      AFTER INSERT ON canvas_doc_write_intents WHEN NEW.status='prepared'
      BEGIN UPDATE canvas_doc_write_intents SET updated_at='2099-01-01T00:00:00.000Z'
        WHERE intent_id=NEW.intent_id; END`);
    let returned = false;
    expect(() =>
      h.authority.transaction((tx) => {
        h.bridge.insertPreparedInTransaction(
          {
            candidate: h.prepared,
            liveSubject: { kind: 'live', request: h.input, actor: h.actor, approved: h.approved },
            freshSnapshot: snapshot,
          },
          tx
        );
        returned = true;
      })
    ).toThrow('Checkbox original transition row changed.');
    expect(returned).toBe(false);
    expect(h.http.channels.getWriteIntent(h.prepared.intentId)).toBeUndefined();
    expect(h.http.channels.getChannel(h.input.documentId)).toEqual(channel);
    expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_events').get()).toEqual({
      n: 0,
    });
    expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_deliveries').get()).toEqual({
      n: 0,
    });
    expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_batches').get()).toEqual({
      n: 0,
    });
    expect(await fs.readFile(h.path)).toEqual(bytes);
    const after = await fs.stat(h.path, { bigint: true });
    expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
  });

  it.each([false, true])(
    'refuses a second genuine prepared original in one scope (caught=%s)',
    async (caught) => {
      const h = await fixture();
      const channel = h.http.channels.getChannel(h.input.documentId)!;
      const bytes = await fs.readFile(h.path),
        identity = await fs.stat(h.path, { bigint: true });
      const secondRequest = CanvasChannelCheckboxRequestSchema.parse({
        ...h.input,
        eventId: randomUUID(),
      });
      const secondApproved = await h.authority.prepare(secondRequest, h.actor);
      expect(secondApproved).toEqual(h.approved);
      const second = observedCheckboxIntent(
        secondRequest,
        secondApproved,
        rawByteHash(Buffer.from(JSON.stringify(secondRequest))),
        new Date().toISOString(),
        rawByteHash(bytes),
        { device: String(identity.dev), inode: String(identity.ino) },
        prepareCheckboxBytes(bytes, secondRequest)
      ).intent;
      expect(second.status).toBe('prepared');
      expect(second.eventId).not.toBe(h.prepared.eventId);
      expect(second.intentId).not.toBe(h.prepared.intentId);
      const firstSnapshot = await h.authority.refreshCurrent(h.input, h.actor, h.approved);
      const secondSnapshot = await h.authority.refreshCurrent(
        secondRequest,
        h.actor,
        secondApproved
      );
      let firstReached = false,
        secondAttempted = false,
        secondRefusal: unknown;
      expect(() =>
        h.authority.transaction((tx) => {
          h.bridge.insertPreparedInTransaction(
            {
              candidate: h.prepared,
              liveSubject: { kind: 'live', request: h.input, actor: h.actor, approved: h.approved },
              freshSnapshot: firstSnapshot,
            },
            tx
          );
          expect(h.http.channels.getWriteIntent(h.prepared.intentId, tx)).toEqual(h.prepared);
          firstReached = true;
          secondAttempted = true;
          const insertSecond = () =>
            h.bridge.insertPreparedInTransaction(
              {
                candidate: second,
                liveSubject: {
                  kind: 'live',
                  request: secondRequest,
                  actor: h.actor,
                  approved: secondApproved,
                },
                freshSnapshot: secondSnapshot,
              },
              tx
            );
          if (!caught) insertSecond();
          else
            try {
              insertSecond();
            } catch (error) {
              secondRefusal = error;
            }
        })
      ).toThrow('Only one checkbox operation may occur per scope.');
      expect(firstReached).toBe(true);
      expect(secondAttempted).toBe(true);
      if (caught)
        expect(secondRefusal).toMatchObject({
          message: 'Only one checkbox operation may occur per scope.',
        });
      expect(h.http.channels.getWriteIntent(h.prepared.intentId)).toBeUndefined();
      expect(h.http.channels.getWriteIntent(second.intentId)).toBeUndefined();
      expect(h.http.channels.getChannel(h.input.documentId)).toEqual(channel);
      expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_events').get()).toEqual({
        n: 0,
      });
      expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_deliveries').get()).toEqual(
        { n: 0 }
      );
      expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_batches').get()).toEqual({
        n: 0,
      });
      expect(await fs.readFile(h.path)).toEqual(bytes);
      const after = await fs.stat(h.path, { bigint: true });
      expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
    }
  );
});

describe('prepared original insert deletion', () => {
  it('refuses an AFTER INSERT deleted prepared original before returning from insert', async () => {
    const h = await fixture();
    const channel = h.http.channels.getChannel(h.input.documentId)!;
    const bytes = await fs.readFile(h.path),
      identity = await fs.stat(h.path, { bigint: true });
    const snapshot = await h.authority.refreshCurrent(h.input, h.actor, h.approved);
    h.db.$client.exec(`CREATE TEMP TRIGGER delete_prepared_after_insert
      AFTER INSERT ON canvas_doc_write_intents WHEN NEW.status='prepared'
      BEGIN DELETE FROM canvas_doc_write_intents WHERE intent_id=NEW.intent_id; END`);
    let returned = false;
    expect(() =>
      h.authority.transaction((tx) => {
        h.bridge.insertPreparedInTransaction(
          {
            candidate: h.prepared,
            liveSubject: { kind: 'live', request: h.input, actor: h.actor, approved: h.approved },
            freshSnapshot: snapshot,
          },
          tx
        );
        returned = true;
      })
    ).toThrow('Checkbox original transition row changed.');
    expect(returned).toBe(false);
    expect(h.http.channels.getWriteIntent(h.prepared.intentId)).toBeUndefined();
    expect(h.http.channels.getChannel(h.input.documentId)).toEqual(channel);
    expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_events').get()).toEqual({
      n: 0,
    });
    expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_deliveries').get()).toEqual({
      n: 0,
    });
    expect(h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_batches').get()).toEqual({
      n: 0,
    });
    expect(await fs.readFile(h.path)).toEqual(bytes);
    const after = await fs.stat(h.path, { bigint: true });
    expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
  });
});
