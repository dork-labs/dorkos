/** Shared setup for the checkbox reservation bridge suites: fixtures, recovery input, and cold-import custody. */
/** Private A/store reservation operations; common outbox and writer activation remain separate. */
import { type ChildProcess } from 'node:child_process';

import fs from 'node:fs/promises';

import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';

import { afterEach, expect } from 'vitest';

import { canvasDocEvents, sql, type DbTransaction } from '@dorkos/db';

import { DOC_INGEST_LIMITS } from '../../../current/accounting.js';

import { authorityFixture } from '../authority-fixtures.js';
import { prepareCheckboxBytes, rawByteHash } from '../../checkbox-bytes.js';
import { observedCheckboxIntent } from '../../checkbox-evidence.js';
import { completionFixture } from '../completion-fixtures.js';
import { createOriginalCheckboxCompletion } from '../../completion.js';
import { createCheckboxReservationBridge } from '../../reservation-bridge.js';
import { validateCheckboxEvidence } from '../../checkbox-evidence.js';
import type { DocWriteIntentRow, DocEventRow } from '../../../store.js';

export interface OwnedColdImport {
  child: ChildProcess;
  closed: Promise<void>;
}
export const ownedColdImports = new Set<OwnedColdImport>();
export function trackColdImport(
  child: ChildProcess,
  argv: string[],
  invokedAt: string,
  started: number
): OwnedColdImport {
  const receipt: Record<string, unknown> = { argv, invokedAt, pid: child.pid ?? null };
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
export async function waitForColdClose(owned: OwnedColdImport): Promise<boolean> {
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
export async function drainColdImports(): Promise<void> {
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
export const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    await drainColdImports();
  } finally {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  }
});
export async function fixture(agentRoute = false) {
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
export async function turnFixture() {
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
export function terminal(
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

export async function recovery(h: Awaited<ReturnType<typeof fixture>>, row: DocWriteIntentRow) {
  return {
    intentId: row.intentId,
    subject: { kind: 'recovery' as const, intent: row, approved: h.approved },
    freshSnapshot: await h.authority.refreshRecoveryCurrent(row, h.approved),
  };
}
