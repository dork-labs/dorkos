/** Bounded stable startup/retry reconciliation; installation must fence before exposing writers. */
import {
  and,
  eq,
  gt,
  inArray,
  or,
  asc,
  canvasDocWriteIntents,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { DocCheckboxWriteService } from './checkbox-service.js';
import type { DocChannelStore, DocWriteIntentRow } from '../store.js';
import { validateCheckboxEvidence, UNRESOLVED_CHECKBOX_STATUSES } from './checkbox-evidence.js';
export interface CheckboxRecoveryCursor {
  updatedAt: string;
  intentId: string;
}
export interface CheckboxRecoveryPage {
  selected: number;
  verified: number;
  retryableFailures: number;
  cursor?: CheckboxRecoveryCursor;
  hasMore: boolean;
}
/** Caller retains keyset cursor and wraps after exhaustion; this leaf owns no retry timer. */
export async function recoverCheckboxPage(
  service: DocCheckboxWriteService,
  cursor?: CheckboxRecoveryCursor,
  limit = 100
): Promise<CheckboxRecoveryPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Invalid checkbox recovery page limit.');
  if (
    cursor &&
    (!Number.isFinite(Date.parse(cursor.updatedAt)) ||
      typeof cursor.intentId !== 'string' ||
      !cursor.intentId)
  )
    throw new Error('Invalid checkbox recovery cursor.');
  service.assertAvailable();
  const rows = service.db
    .select({
      intentId: canvasDocWriteIntents.intentId,
      updatedAt: canvasDocWriteIntents.updatedAt,
    })
    .from(canvasDocWriteIntents)
    .where(
      and(
        inArray(canvasDocWriteIntents.status, [...UNRESOLVED_CHECKBOX_STATUSES]),
        cursor
          ? or(
              gt(canvasDocWriteIntents.updatedAt, cursor.updatedAt),
              and(
                eq(canvasDocWriteIntents.updatedAt, cursor.updatedAt),
                gt(canvasDocWriteIntents.intentId, cursor.intentId)
              )
            )
          : undefined
      )
    )
    .orderBy(asc(canvasDocWriteIntents.updatedAt), asc(canvasDocWriteIntents.intentId))
    .limit(limit + 1)
    .all();
  let verified = 0,
    retryableFailures = 0;
  for (const row of rows.slice(0, limit)) {
    try {
      if ((await service.recover(row.intentId)).status === 'changed') verified++;
    } catch {
      retryableFailures++;
    }
  }
  const last = rows.slice(0, limit).at(-1);
  return {
    selected: Math.min(rows.length, limit),
    verified,
    retryableFailures,
    ...(last ? { cursor: last } : {}),
    hasMore: rows.length > limit,
  };
}

/** Keep corrupt/uncertain evidence fenced without refreshing previously quarantined cursor keys. */
export function quarantineCheckboxIntent(
  store: DocChannelStore,
  id: string,
  reason: string,
  now: string
): void {
  store.transaction((tx) => {
    tx.update(canvasDocWriteIntents)
      .set({ status: 'in_doubt', errorCode: reason, updatedAt: now })
      .where(
        and(
          eq(canvasDocWriteIntents.intentId, id),
          inArray(canvasDocWriteIntents.status, ['prepared', 'replaced'])
        )
      )
      .run();
  });
}
/** A proven refusal before target replacement is terminal and creates no changed host event. */
export function markCheckboxConflict(
  store: DocChannelStore,
  row: DocWriteIntentRow,
  now: string,
  refused: boolean
): void {
  store.transaction((tx) => {
    store.transitionWriteIntent(
      row.intentId,
      'prepared',
      {
        status: 'conflict',
        updatedAt: now,
        errorCode: refused ? 'authority_refused' : 'source_conflict',
        evidence: {
          ...validateCheckboxEvidence(row),
          receipt: { status: 'conflict', eventId: row.eventId, action: 'reload' },
        },
      },
      tx
    );
  });
}

/** Local ledger lookup; production composition can consolidate this into the authoritative store. */
export function findCheckboxIntent(
  store: DocChannelStore,
  db: Db,
  documentId: string,
  eventId: string,
  tx?: DbTransaction
): DocWriteIntentRow | undefined {
  const id = (tx ?? db)
    .select({ id: canvasDocWriteIntents.intentId })
    .from(canvasDocWriteIntents)
    .where(
      and(
        eq(canvasDocWriteIntents.documentId, documentId),
        eq(canvasDocWriteIntents.eventId, eventId)
      )
    )
    .get()?.id;
  return id ? store.getWriteIntent(id, tx) : undefined;
}
