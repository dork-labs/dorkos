/** Private A/store reservation operations; common outbox and writer activation remain separate. */
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import os from 'node:os';
import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import { loadCeilingMs, loadScaledMs } from '@dorkos/shared/test-budget';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  createDb,
  canvasDocuments,
  canvasDocEvents,
  canvasDocWriteIntents,
  canvasDocGrants,
  canvasDocChannels,
  eq,
  sql,
  type DbTransaction,
} from '@dorkos/db';
import { DocChannelStore } from '../../store.js';
import { DOC_INGEST_LIMITS } from '../../current/accounting.js';
import { DocIngestRefusal } from '../../ingest-types.js';
import { scanCheckboxReservationPolicies } from '../reservations/reservation-policy-census.js';
import { DocCheckboxAuthority } from '../authority.js';
import { CheckboxAuthorityCallbackError } from '../authority-snapshot.js';
import { authorityFixture } from './authority-fixtures.js';
import { prepareCheckboxBytes, rawByteHash } from '../checkbox-bytes.js';
import { observedCheckboxIntent } from '../checkbox-evidence.js';
import { completionFixture } from './completion-fixtures.js';
import { createOriginalCheckboxCompletion } from '../completion.js';
import {
  createCheckboxReservationBridge,
  retireCheckboxReservationScope,
} from '../reservations/reservation-bridge.js';
import { validateCheckboxEvidence } from '../checkbox-evidence.js';
import type { DocWriteIntentRow, DocEventRow } from '../../store.js';

/** Numeric invocation context only; diagnostic failures cannot affect the owned child. */
function coldImportInvocationMetadata(timeoutMs: number) {
  const numeric = (read: () => number): number | 'unavailable' => {
    try {
      const value = read();
      return Number.isFinite(value) && value >= 0 ? value : 'unavailable';
    } catch {
      return 'unavailable';
    }
  };
  return {
    timeoutMs,
    loadavg1: numeric(() => os.loadavg()[0]!),
    cpuCount: numeric(() => os.cpus().length),
    availableParallelism: numeric(() => os.availableParallelism()),
    parentRssMiB: numeric(() => Math.round(process.memoryUsage().rss / 1024 / 1024)),
    freeMemMiB: numeric(() => Math.round(os.freemem() / 1024 / 1024)),
    totalMemMiB: numeric(() => Math.round(os.totalmem() / 1024 / 1024)),
    tsxDiskCacheEnabled: !process.env.TSX_DISABLE_CACHE,
  };
}

interface OwnedColdImport {
  child: ChildProcess;
  closed: Promise<void>;
}
const ownedColdImports = new Set<OwnedColdImport>();
function trackColdImport(
  child: ChildProcess,
  argv: string[],
  invokedAt: string,
  started: number,
  invocationMetadata: ReturnType<typeof coldImportInvocationMetadata>
): OwnedColdImport {
  const importPhases: { phase: string; elapsedMs: number }[] = [];
  const receipt: Record<string, unknown> = {
    argv,
    invokedAt,
    pid: child.pid ?? null,
    importPhases,
    invocationMetadata,
  };
  let phaseLine = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    phaseLine += chunk.toString();
    let newline: number;
    while ((newline = phaseLine.indexOf('\n')) !== -1) {
      const line = phaseLine.slice(0, newline);
      phaseLine = phaseLine.slice(newline + 1);
      const match =
        /^ORIGINAL_COLD_PHASE (first-start|first-ready|remaining-ready|remaining-[0-5]-(?:start|ready)) ([0-9]+)$/.exec(
          line
        );
      if (match && importPhases.length < 15) {
        const elapsedMs = Number(match[2]);
        if (Number.isSafeInteger(elapsedMs)) importPhases.push({ phase: match[1], elapsedMs });
      }
    }
    if (phaseLine.length > 128) phaseLine = '';
  });
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const owned = { child, closed };
  ownedColdImports.add(owned);
  child.once('spawn', () => {
    receipt.spawnedAt = new Date().toISOString();
    receipt.pid = child.pid ?? null;
  });
  child.once('error', (error) => {
    receipt.error = { name: error.name, message: error.message };
  });
  child.once('exit', (code, signal) => {
    receipt.exitedAt = new Date().toISOString();
    receipt.exitCode = code;
    receipt.exitSignal = signal;
  });
  child.once('close', (code, signal) => {
    receipt.closedAt = new Date().toISOString();
    receipt.closeCode = code;
    receipt.closeSignal = signal;
    receipt.elapsedMs = performance.now() - started;
    ownedColdImports.delete(owned);
    console.info('[checkbox-native-import]', JSON.stringify(receipt));
    finish();
  });
  return owned;
}
async function waitForColdClose(owned: OwnedColdImport): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      owned.closed.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function drainColdImports(): Promise<void> {
  for (const owned of [...ownedColdImports]) {
    if (owned.child.exitCode === null && owned.child.signalCode === null)
      owned.child.kill('SIGTERM');
    if (await waitForColdClose(owned)) continue;
    if (owned.child.exitCode === null && owned.child.signalCode === null)
      owned.child.kill('SIGKILL');
    if (!(await waitForColdClose(owned)))
      throw new Error('Owned native import child did not close after bounded cleanup.');
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    await drainColdImports();
  } finally {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  }
});
async function fixture(agentRoute = false) {
  const h = await (agentRoute ? turnFixture() : completionFixture());
  cleanups.push(h.cleanup);
  return {
    ...h,
    bridge: createCheckboxReservationBridge(h.authority, h.http.channels, DOC_INGEST_LIMITS),
    completion: createOriginalCheckboxCompletion({
      authority: h.authority,
      store: h.http.channels,
      policyLimits: DOC_INGEST_LIMITS,
      notifyCommitted: () => undefined,
    }),
  };
}
async function turnFixture() {
  const h = await authorityFixture(false, false, true);
  const before = await fs.readFile(h.path),
    stat = await fs.stat(h.path, { bigint: true });
  const input = CanvasChannelCheckboxRequestSchema.parse({
    ...h.input,
    expectedFileVersion: rawByteHash(before),
    textHash: rawByteHash(before.subarray(0, before.length - 1)),
  });
  const approved = await h.authority.prepare(input, h.actor),
    edit = prepareCheckboxBytes(before, input);
  const prepared = observedCheckboxIntent(
    input,
    approved,
    rawByteHash(Buffer.from(JSON.stringify(input))),
    new Date().toISOString(),
    rawByteHash(before),
    { device: String(stat.dev), inode: String(stat.ino) },
    edit
  ).intent as DocWriteIntentRow;
  const replace = async () => {
    h.http.channels.insertWriteIntent(prepared);
    const physical = validateCheckboxEvidence(prepared);
    await fs.writeFile(physical.tempPath!, edit.after, { flag: 'wx' });
    const replacement = await fs.stat(physical.tempPath!, { bigint: true });
    await fs.rename(physical.tempPath!, h.path);
    h.http.channels.transitionWriteIntent(prepared.intentId, 'prepared', {
      status: 'replaced',
      updatedAt: new Date().toISOString(),
      errorCode: null,
      evidence: {
        ...physical,
        tempIdentity: { device: String(replacement.dev), inode: String(replacement.ino) },
      },
    });
    return h.http.channels.getWriteIntent(prepared.intentId)!;
  };
  return { ...h, input, approved, prepared, replace };
}
function terminal(
  tx: DbTransaction,
  row: DocWriteIntentRow,
  event: DocEventRow,
  h: Awaited<ReturnType<typeof fixture>>
): void {
  const receipt = h.completion.finishInTransaction(tx);
  expect(receipt).toEqual({
    status: 'changed',
    fileVersion: row.afterHash,
    receipt: { id: row.eventId, status: 'recorded', docSeq: event.docSeq },
  });
  const delivery = h.http.channels.listDeliveries(row.documentId, row.eventId, tx)[0]!;
  const frame = tx
    .select()
    .from(canvasDocEvents)
    .where(
      sql`${canvasDocEvents.documentId}=${row.documentId} AND ${canvasDocEvents.docSeq}=${event.docSeq + 1}`
    )
    .get()!;
  expect(frame).toMatchObject({
    direction: 'system',
    type: 'event.status',
    payload: {
      eventId: row.eventId,
      routeId: delivery.routeId,
      status: delivery.status,
      ...(delivery.batchId !== null ? { batchId: delivery.batchId } : {}),
      ...(delivery.reason !== null ? { reason: delivery.reason } : {}),
    },
  });
}

async function recovery(h: Awaited<ReturnType<typeof fixture>>, row: DocWriteIntentRow) {
  return {
    intentId: row.intentId,
    subject: { kind: 'recovery' as const, intent: row, approved: h.approved },
    freshSnapshot: await h.authority.refreshRecoveryCurrent(row, h.approved),
  };
}

describe('fixed owning checkbox reservation bridge', () => {
  it('reserves a genuine live prepared row without an event, sequence or file effect', async () => {
    const h = await fixture();
    const before = h.http.channels.getChannel(h.input.documentId)!;
    const snapshot = await h.authority.refreshCurrent(h.input, h.actor, h.approved);
    h.authority.transaction((tx) =>
      h.bridge.insertPreparedInTransaction(
        {
          candidate: h.prepared,
          liveSubject: { kind: 'live', request: h.input, actor: h.actor, approved: h.approved },
          freshSnapshot: snapshot,
        },
        tx
      )
    );
    expect(h.http.channels.getWriteIntent(h.prepared.intentId)).toEqual(h.prepared);
    expect(h.http.channels.getChannel(h.input.documentId)).toEqual(before);
    expect(h.http.channels.getEvent(h.input.documentId, h.input.eventId)).toBeUndefined();
  });

  it('converts exactly one existing replaced original and audits its exact recorded terminal receipt', async () => {
    const h = await fixture();
    const row = await h.replace();
    const input = await recovery(h, row);
    let appended: DocEventRow | undefined;
    h.authority.transaction((tx) => {
      appended = h.bridge.convertOwnReservationInTransaction(input, tx);
      terminal(tx, row, appended, h);
    });
    const event = h.http.channels.getEvent(row.documentId, row.eventId)!;
    expect(event).toEqual(appended);
    expect(event.type).toBe('md.task.toggled');
    expect(event.provenance).toEqual({
      transport: 'host',
      producer: 'verified_checkbox',
      intentId: row.intentId,
    });
    expect(event.payload).toMatchObject({
      beforeFileVersion: row.beforeHash,
      afterFileVersion: row.afterHash,
    });
    expect(event.envelopeHash).not.toBe(row.envelopeHash);
    expect(
      validateCheckboxEvidence(h.http.channels.getWriteIntent(row.intentId)!).receipt?.status
    ).toBe('changed');
    expect(h.http.channels.getChannel(row.documentId)?.nextDocSeq).toBe(event.docSeq + 2);
  });

  it('credits the exact owning pending-turn row once against independently lowered rate and pending caps', async () => {
    const h = await fixture(true);
    const row = await h.replace();
    const strict = createCheckboxReservationBridge(h.authority, h.http.channels, {
      ...DOC_INGEST_LIMITS,
      pendingEvents: 1,
      pendingBytes: 10000,
      eventsPerMinute: 1,
    });
    const input = await recovery(h, row);
    h.authority.transaction((tx) => {
      const event = strict.convertOwnReservationInTransaction(input, tx);
      terminal(tx, row, event, h);
    });
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeDefined();
  });

  it.each(['eventsPerMinute', 'pendingEvents'] as const)(
    'does not credit another original held row against the lowered %s cap',
    async (cap) => {
      const h = await fixture(true);
      const other = structuredClone(h.prepared);
      other.intentId = 'other-held-original';
      other.eventId = randomUUID();
      other.input = { ...(other.input as object), eventId: other.eventId };
      other.envelopeHash = rawByteHash(Buffer.from(JSON.stringify(other.input)));
      other.evidence = {
        ...(other.evidence as object),
        tempPath: join(other.resolvedCwd, `.dork-checkbox-${other.intentId}.tmp`),
      };
      const row = await h.replace();
      h.http.channels.insertWriteIntent(other);
      const held = h.http.channels.transaction((tx) =>
        scanCheckboxReservationPolicies(tx, {
          documentId: row.documentId,
          eventId: row.eventId,
          routeId: h.approved.routeId!,
        })
      );
      expect(held.document.rateUnits).toBe(2);
      expect(held.document.originals).toBe(2);
      expect(held.route.originals).toBe(2);
      const strict = createCheckboxReservationBridge(h.authority, h.http.channels, {
        ...DOC_INGEST_LIMITS,
        [cap]: 1,
      });
      const input = await recovery(h, row);
      const before = h.http.channels.getChannel(row.documentId)!;
      let refusal: unknown;
      try {
        h.authority.transaction((tx) => strict.convertOwnReservationInTransaction(input, tx));
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(DocIngestRefusal);
      expect((refusal as DocIngestRefusal).status).toBe(429);
      expect((refusal as DocIngestRefusal).code).toBe(
        cap === 'eventsPerMinute' ? 'DOC_EVENT_RATE_LIMIT' : 'DOC_EVENT_BACKLOG_FULL'
      );
      expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
      expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
      expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
      expect(h.http.channels.getWriteIntent(other.intentId)).toEqual(other);
    }
  );

  it('uses the actual fresh SQL label and rejects oversized pending context before any admission', async () => {
    const h = await fixture(true);
    const label = '😀"</doc_events>--- END '.repeat(30).slice(0, 500);
    h.db
      .update(canvasDocuments)
      .set({ title: label })
      .where(eq(canvasDocuments.id, h.input.documentId))
      .run();
    const fresh = await h.authority.refreshCurrent(h.input, h.actor, h.approved);
    h.authority.transaction((tx) =>
      h.bridge.insertPreparedInTransaction(
        {
          candidate: h.prepared,
          liveSubject: { kind: 'live', request: h.input, actor: h.actor, approved: h.approved },
          freshSnapshot: fresh,
        },
        tx
      )
    );
    expect(h.http.channels.getWriteIntent(h.prepared.intentId)).toBeDefined();
    expect(h.http.channels.getEvent(h.input.documentId, h.input.eventId)).toBeUndefined();
    const invalid = await fixture(true);
    invalid.db
      .update(canvasDocuments)
      .set({ title: '😀'.repeat(501) })
      .where(eq(canvasDocuments.id, invalid.input.documentId))
      .run();
    const second = await invalid.authority.refreshCurrent(
      invalid.input,
      invalid.actor,
      invalid.approved
    );
    expect(() =>
      invalid.authority.transaction((tx) =>
        invalid.bridge.insertPreparedInTransaction(
          {
            candidate: invalid.prepared,
            liveSubject: {
              kind: 'live',
              request: invalid.input,
              actor: invalid.actor,
              approved: invalid.approved,
            },
            freshSnapshot: second,
          },
          tx
        )
      )
    ).toThrow();
    expect(invalid.http.channels.getWriteIntent(invalid.prepared.intentId)).toBeUndefined();
    expect(invalid.http.channels.getChannel(invalid.input.documentId)?.nextDocSeq).toBe(1);
  });

  it('log-only approval holds rate without manufacturing runtime context or a pending slot', async () => {
    const h = await fixture();
    h.db
      .update(canvasDocuments)
      .set({ title: '😀'.repeat(1000) })
      .where(eq(canvasDocuments.id, h.input.documentId))
      .run();
    const fresh = await h.authority.refreshCurrent(h.input, h.actor, h.approved);
    h.authority.transaction((tx) =>
      h.bridge.insertPreparedInTransaction(
        {
          candidate: h.prepared,
          liveSubject: { kind: 'live', request: h.input, actor: h.actor, approved: h.approved },
          freshSnapshot: fresh,
        },
        tx
      )
    );
    expect(h.http.channels.getWriteIntent(h.prepared.intentId)).toBeDefined();
    expect(h.http.channels.getEvent(h.input.documentId, h.input.eventId)).toBeUndefined();
  });

  it('rolls back conversion without the sanctioned terminal projection even when caller catches its own omission', async () => {
    const h = await fixture();
    const row = await h.replace();
    const input = await recovery(h, row);
    const before = h.http.channels.getChannel(row.documentId)!;
    expect(() =>
      h.authority.transaction((tx) => {
        h.bridge.convertOwnReservationInTransaction(input, tx);
      })
    ).toThrow('terminal receipt');
    expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
    expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
  });

  it.each(['timestamp', 'receipt', 'event'] as const)(
    'rolls back a converted original when its final %s evidence is altered',
    async (kind) => {
      const h = await fixture();
      const row = await h.replace();
      const input = await recovery(h, row);
      const before = h.http.channels.getChannel(row.documentId)!;
      expect(() =>
        h.authority.transaction((tx) => {
          const event = h.bridge.convertOwnReservationInTransaction(input, tx);
          terminal(tx, row, event, h);
          if (kind === 'timestamp')
            tx.update(canvasDocWriteIntents)
              .set({ updatedAt: 'not-a-time' })
              .where(eq(canvasDocWriteIntents.intentId, row.intentId))
              .run();
          else if (kind === 'receipt')
            tx.update(canvasDocWriteIntents)
              .set({
                evidence: {
                  ...(row.evidence as object),
                  receipt: {
                    status: 'changed',
                    fileVersion: row.afterHash,
                    receipt: { id: row.eventId, status: 'recorded', docSeq: event.docSeq + 1 },
                  },
                },
              })
              .where(eq(canvasDocWriteIntents.intentId, row.intentId))
              .run();
          else
            tx.update(canvasDocEvents)
              .set({ receivedAt: '2020-01-01T00:00:00.000Z' })
              .where(eq(canvasDocEvents.eventId, row.eventId))
              .run();
        })
      ).toThrow(
        kind === 'timestamp'
          ? ZodError
          : kind === 'receipt'
            ? 'Checkbox terminal projection changed.'
            : 'Checkbox converted event changed before commit.'
      );
      expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
      expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
      expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
    }
  );

  it('a second attempted conversion poisons the entire scope even if caught after the first terminal CAS', async () => {
    const h = await fixture();
    const row = await h.replace();
    const input = await recovery(h, row);
    expect(() =>
      h.authority.transaction((tx) => {
        const event = h.bridge.convertOwnReservationInTransaction(input, tx);
        terminal(tx, row, event, h);
        try {
          h.bridge.convertOwnReservationInTransaction(input, tx);
        } catch {
          /* deliberate caller suppression */
        }
      })
    ).toThrow('Only one checkbox conversion');
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
    expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
  });

  it('cannot clear the private rollback latch with the returned bridge or any caller object', async () => {
    const h = await fixture();
    const row = await h.replace();
    const input = await recovery(h, row);
    expect(() =>
      h.authority.transaction((tx) => {
        const event = h.bridge.convertOwnReservationInTransaction(input, tx);
        terminal(tx, row, event, h);
        try {
          h.bridge.convertOwnReservationInTransaction(input, tx);
        } catch {
          /* intentional */
        }
        expect(() => retireCheckboxReservationScope(tx, h.bridge)).toThrow('scope exit is private');
      })
    ).toThrow('Only one checkbox conversion');
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
  });

  it('a separately active file connection cannot lend a stale transaction authority', async () => {
    const h = await fixture();
    const row = await h.replace();
    const input = await recovery(h, row);
    const foreign = createDb(h.file);
    try {
      expect(() =>
        h.authority.transaction(() =>
          foreign.transaction((tx) => h.bridge.convertOwnReservationInTransaction(input, tx))
        )
      ).toThrow('exact active transaction');
    } finally {
      foreign.$client.close();
    }
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
  });

  it('refuses fake, proxy and different-database stores before binding', async () => {
    const h = await fixture();
    const foreign = createDb(h.file);
    try {
      expect(() =>
        createCheckboxReservationBridge(
          h.authority,
          new DocChannelStore(foreign),
          DOC_INGEST_LIMITS
        )
      ).toThrow('mismatch');
      expect(() =>
        createCheckboxReservationBridge(
          h.authority,
          new Proxy(h.http.channels, {}),
          DOC_INGEST_LIMITS
        )
      ).toThrow('mismatch');
      expect(
        () =>
          new DocCheckboxAuthority({ ...h.deps, store: Object.create(DocChannelStore.prototype) })
      ).toThrow('genuine store transaction database');
    } finally {
      foreign.$client.close();
    }
  });

  it('captures real dependency fields without invoking accessors or proxy traps', async () => {
    const h = await fixture();
    let reads = 0;
    const accessor = { ...h.deps };
    Object.defineProperty(accessor, 'db', {
      get() {
        reads++;
        return h.db;
      },
    });
    expect(() => new DocCheckboxAuthority(accessor)).toThrow('own data');
    expect(reads).toBe(0);
    expect(
      () =>
        new DocCheckboxAuthority(
          new Proxy(h.deps, {
            getPrototypeOf() {
              reads++;
              return Object.prototype;
            },
          })
        )
    ).toThrow('own data');
    expect(reads).toBe(0);
  });

  it('refuses revoked current original authority after the actual filesystem refresh', async () => {
    const h = await fixture();
    const row = await h.replace();
    const input = await recovery(h, row);
    h.db
      .update(canvasDocGrants)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(canvasDocGrants.grantId, row.grantId))
      .run();
    expect(() =>
      h.authority.transaction((tx) => h.bridge.convertOwnReservationInTransaction(input, tx))
    ).toThrow();
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
    expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
  });

  it('retires the original snapshot after a first conversion clock writes, rolls back and throws', async () => {
    const h = await fixture();
    const row = await h.replace();
    const before = h.http.channels.getChannel(row.documentId)!;
    const cause = new Error('configured first conversion clock failed after rolled-back SQL');
    let failClock = false;
    const authority = new DocCheckboxAuthority({
      ...h.deps,
      now: () => {
        if (!failClock) return h.deps.now();
        h.db.$client.exec('SAVEPOINT checkbox_clock');
        h.db.$client
          .prepare('UPDATE canvas_doc_grants SET revision=revision+1 WHERE grant_id=?')
          .run(row.grantId);
        h.db.$client.exec('ROLLBACK TO checkbox_clock; RELEASE checkbox_clock');
        throw cause;
      },
    });
    const bridge = createCheckboxReservationBridge(authority, h.http.channels, DOC_INGEST_LIMITS);
    const completion = createOriginalCheckboxCompletion({
      authority,
      store: h.http.channels,
      policyLimits: DOC_INGEST_LIMITS,
      notifyCommitted: () => undefined,
    });
    const input = {
      intentId: row.intentId,
      subject: { kind: 'recovery' as const, intent: row, approved: h.approved },
      freshSnapshot: await authority.refreshRecoveryCurrent(row, h.approved),
    };
    failClock = true;
    let first: unknown;
    try {
      authority.transaction((tx) => bridge.convertOwnReservationInTransaction(input, tx));
    } catch (error) {
      first = error;
    }
    expect(first).toBeInstanceOf(CheckboxAuthorityCallbackError);
    expect((first as Error).cause).toBe(cause);
    expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
    expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
    failClock = false;
    expect(() =>
      authority.transaction((tx) => {
        const converted = bridge.convertOwnReservationInTransaction(input, tx);
        terminal(tx, row, converted, { ...h, completion });
      })
    ).toThrow('foreign, stale or already consumed');
    expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
    expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
  });

  it('preserves the first thrown undefined and rolls back caught callback failure', async () => {
    const h = await fixture();
    const row = await h.replace();
    let failClock = false;
    const authority = new DocCheckboxAuthority({
      ...h.deps,
      now: () => {
        if (failClock) throw undefined;
        return h.deps.now();
      },
    });
    const bridge = createCheckboxReservationBridge(authority, h.http.channels, DOC_INGEST_LIMITS);
    const input = {
      intentId: row.intentId,
      subject: { kind: 'recovery' as const, intent: row, approved: h.approved },
      freshSnapshot: await authority.refreshRecoveryCurrent(row, h.approved),
    };
    failClock = true;
    let returned = false;
    let caught = false;
    let cause: unknown = 'sentinel';
    try {
      authority.transaction((tx) => {
        try {
          bridge.convertOwnReservationInTransaction(input, tx);
        } catch {
          /* undefined remains failure */
        }
        tx.update(canvasDocChannels)
          .set({ stateRev: 99 })
          .where(eq(canvasDocChannels.documentId, row.documentId))
          .run();
      });
      returned = true;
    } catch (error) {
      caught = true;
      cause = error;
    }
    expect(caught).toBe(true);
    expect(cause).toBeUndefined();
    expect(returned).toBe(false);
    expect(h.http.channels.getChannel(row.documentId)?.stateRev).toBe(0);
  });

  it('ordinary event and state UUID paths refuse before sequence or state allocation', async () => {
    const h = await fixture();
    h.http.channels.insertWriteIntent(h.prepared);
    const before = h.http.channels.getChannel(h.input.documentId)!;
    const event = {
      documentId: h.input.documentId,
      eventId: h.input.eventId,
      direction: 'system' as const,
      type: 'state.changed',
      payload: {},
      envelopeHash: 'a'.repeat(64),
      provenance: {},
      receivedAt: new Date().toISOString(),
    };
    expect(() => h.http.channels.appendEvent(event)).toThrow('permanently reserved');
    expect(() =>
      h.http.channels.replaceState({
        documentId: h.input.documentId,
        expectedStateRev: 0,
        state: { changed: true },
        event,
      })
    ).toThrow('permanently reserved');
    expect(h.http.channels.getChannel(h.input.documentId)).toEqual(before);
  });

  it('caller journal writes outside read-only authority gates still commit in an ordinary A transaction', async () => {
    const h = await fixture();
    h.authority.transaction((tx) => {
      tx.run(
        sql`UPDATE canvas_doc_channels SET state_rev=1 WHERE document_id=${h.input.documentId}`
      );
    });
    expect(h.http.channels.getChannel(h.input.documentId)?.stateRev).toBe(1);
    expect(h.db.select().from(canvasDocEvents).all()).toHaveLength(0);
  });
});

const canvasEntry = new URL('../../../canvas-service.ts', import.meta.url).href;
const roomCanvasEntry = new URL('../../../../rooms/canvas/room-canvas-service.ts', import.meta.url)
  .href;
const importEntries = [
  new URL('../../store.ts', import.meta.url).href,
  new URL('../authority.ts', import.meta.url).href,
  new URL('../authority-policy.ts', import.meta.url).href,
  new URL('../reservations/reservation-bridge.ts', import.meta.url).href,
  new URL('../reservations/reservation-policy-census.ts', import.meta.url).href,
  canvasEntry,
  roomCanvasEntry,
];
it.each(importEntries)(
  'cold-loads the declarations-only cycle starting at %s',
  async (first) => {
    const program =
      `const originalImportStarted = performance.now();
const originalImportPhase = phase => console.log('ORIGINAL_COLD_PHASE ' + phase + ' ' + Math.round(performance.now() - originalImportStarted));
originalImportPhase('first-start');
const first = await import(${JSON.stringify(first)});
originalImportPhase('first-ready');
` +
      importEntries
        .filter((entry) => entry !== first)
        .map(
          (entry, index) =>
            `originalImportPhase('remaining-${index}-start');
await import(${JSON.stringify(entry)});
originalImportPhase('remaining-${index}-ready');`
        )
        .join('\n') +
      `\noriginalImportPhase('remaining-ready');
const canvas = await import(${JSON.stringify(canvasEntry)});
const roomCanvas = await import(${JSON.stringify(roomCanvasEntry)});
if (canvas.MAX_CANVAS_DOCUMENTS !== 12 || roomCanvas.MAX_ROOM_CANVAS_DOCUMENTS !== 12)
  throw new Error('Uninitialized original canvas capacity');
if (!Object.keys(first).length) throw new Error('Empty entry'); console.log('cold-import-complete');`;
    const argv = ['--import', 'tsx', '--input-type=module', '-e', program];
    const timeoutMs = loadScaledMs(5000);
    const invocationMetadata = coldImportInvocationMetadata(timeoutMs);
    const invokedAt = new Date().toISOString(),
      started = performance.now();
    const running = promisify(execFile)(process.execPath, argv, {
      cwd: process.cwd(),
      timeout: timeoutMs,
    });
    void running.catch(() => {});
    const owned = trackColdImport(
      running.child,
      [process.execPath, ...argv],
      invokedAt,
      started,
      invocationMetadata
    );
    let failed = false,
      firstCause: unknown;
    try {
      const { stdout, stderr } = await running;
      await owned.closed;
      expect(stdout).toContain('cold-import-complete');
      expect(stderr).not.toContain('before initialization');
    } catch (cause) {
      failed = true;
      firstCause = cause;
    } finally {
      try {
        await drainColdImports();
      } catch (cause) {
        if (!failed) {
          failed = true;
          firstCause = cause;
        }
      }
    }
    if (failed) throw firstCause;
  },
  loadCeilingMs(5000) + 2 * 1000
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
