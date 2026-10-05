/** Bounded stable startup/retry reconciliation; installation must fence before exposing writers. */
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
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

/** Reduce only the exact validated unresolved row; unavailable/corrupt evidence stays fenced unchanged. */
export function quarantineCheckboxIntent(
  store: DocChannelStore,
  expected: DocWriteIntentRow,
  reason: string,
  now: string
): void {
  validateCheckboxEvidence(expected);
  if (!['prepared', 'replaced'].includes(expected.status)) return;
  store.transaction((tx) => {
    const current = store.getWriteIntent(expected.intentId, tx);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected))
      throw new Error('Checkbox quarantine original row changed.');
    validateCheckboxEvidence(current);
    const next = { ...current, status: 'in_doubt' as const, errorCode: reason, updatedAt: now };
    const changed = tx
      .update(canvasDocWriteIntents)
      .set({ status: next.status, errorCode: reason, updatedAt: now })
      .where(
        and(
          eq(canvasDocWriteIntents.intentId, current.intentId),
          eq(canvasDocWriteIntents.documentId, current.documentId),
          eq(canvasDocWriteIntents.eventId, current.eventId),
          eq(canvasDocWriteIntents.envelopeHash, current.envelopeHash),
          eq(canvasDocWriteIntents.grantId, current.grantId),
          eq(canvasDocWriteIntents.sourceIdentity, current.sourceIdentity),
          eq(canvasDocWriteIntents.resolvedCwd, current.resolvedCwd),
          eq(canvasDocWriteIntents.treeKind, current.treeKind),
          eq(canvasDocWriteIntents.canonicalPath, current.canonicalPath),
          eq(canvasDocWriteIntents.operation, current.operation),
          eq(canvasDocWriteIntents.input, current.input),
          eq(canvasDocWriteIntents.beforeHash, current.beforeHash),
          eq(canvasDocWriteIntents.afterHash, current.afterHash),
          eq(canvasDocWriteIntents.expectedVersion, current.expectedVersion),
          eq(canvasDocWriteIntents.evidence, current.evidence),
          eq(canvasDocWriteIntents.status, current.status),
          current.errorCode === null
            ? isNull(canvasDocWriteIntents.errorCode)
            : eq(canvasDocWriteIntents.errorCode, current.errorCode),
          eq(canvasDocWriteIntents.createdAt, current.createdAt),
          eq(canvasDocWriteIntents.updatedAt, current.updatedAt)
        )
      )
      .run();
    if (
      changed.changes !== 1 ||
      JSON.stringify(store.getWriteIntent(current.intentId, tx)) !== JSON.stringify(next)
    )
      throw new Error('Checkbox quarantine changed its original evidence.');
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
