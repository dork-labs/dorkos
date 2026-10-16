/** Validated ordinary-save evidence and UUID/path fences; none of these reads grants authority. */
import { z } from 'zod';
import {
  and,
  asc,
  eq,
  gt,
  notInArray,
  or,
  isNull,
  type Db,
  type DbTransaction,
  canvasDocFileSaveIntents,
} from '@dorkos/db';
import {
  CanvasDocIncarnationSchema,
  CanvasChannelEventIdSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { assertJson, DocChannelCorruptionError } from '../store-json.js';
import type { CanonicalFileIdentity } from './canonical-writer.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const physicalId = z.string().regex(/^[0-9]+$/u);
const text = z.string().min(1).max(200);
const SourceSchema = z
  .object({
    id: text,
    scope: z.string().min(1).max(400),
    openedAt: z.string().datetime({ offset: true }),
    authorId: text,
    sourceIdentity: z.string().nullable(),
    sourcePath: z.string().nullable(),
    resolvedCwd: z.string().nullable(),
    treeKind: z.string().nullable(),
    rootCandidate: z.string().nullable(),
    matchRoot: z.string().nullable(),
    allowedRoot: z.string().nullable(),
  })
  .strict();
const OwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local_install'), installationId: text }).strict(),
  z.object({ kind: z.literal('user'), userId: text }).strict(),
]);
const IntentSchema = z
  .object({
    intentId: text,
    documentId: text,
    eventId: CanvasChannelEventIdSchema,
    requestHash: hash,
    incarnation: CanvasDocIncarnationSchema,
    source: SourceSchema,
    owner: OwnerSchema,
    canonicalPath: z.string().min(1),
    beforeDevice: physicalId,
    beforeInode: physicalId,
    beforeHash: hash,
    afterHash: hash,
    replacementDevice: physicalId.nullable(),
    replacementInode: physicalId.nullable(),
    status: z.enum(['prepared', 'staged', 'committed', 'no_op', 'in_doubt', 'failed']),
    docSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((row, context) => {
    if (
      row.documentId !== row.incarnation.documentId ||
      row.source.id !== row.documentId ||
      row.source.openedAt !== row.incarnation.physicalOpenedAt ||
      (row.replacementDevice === null) !== (row.replacementInode === null) ||
      (['staged', 'committed'].includes(row.status) && row.replacementDevice === null) ||
      (row.status === 'committed') !== (row.docSeq !== null) ||
      (['prepared', 'no_op', 'failed'].includes(row.status) && row.replacementInode !== null) ||
      (row.status === 'no_op' && row.beforeHash !== row.afterHash)
    )
      context.addIssue({ code: 'custom', message: 'Invalid ordinary save evidence' });
  });
export type FileSaveIntentRow = z.infer<typeof IntentSchema>;

/** A durable original save currently owns this file identity or canonical path. */
export class FileSaveWriteFencedError extends Error {
  /** Preserve the original admission refusal without treating it as an unavailable read. */
  constructor() {
    super('File has an unresolved original save');
    this.name = 'FileSaveWriteFencedError';
  }
}

/** Malformed durable evidence is never interpreted as a vacant UUID or clear file. */
export function validateFileSaveIntent(raw: unknown): FileSaveIntentRow {
  try {
    // This table has nullable docSeq until committed. The global row reader intentionally
    // requires every ordinary docSeq to be positive, so use this table's stricter phase schema.
    assertJson(raw);
    const parsed = IntentSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Invalid ordinary save evidence');
    return parsed.data;
  } catch (cause) {
    throw new DocChannelCorruptionError('canvas_doc_file_save_intents', 'evidence', { cause });
  }
}

/** Decode only this table, retaining native SQLite failures and rejecting malformed JSON/evidence. */
function readFileSaveChecked<T>(recordId: string, read: () => T): T {
  let result: T;
  try {
    result = read();
  } catch (cause) {
    if (cause instanceof SyntaxError)
      throw new DocChannelCorruptionError('canvas_doc_file_save_intents', recordId, { cause });
    throw cause;
  }
  if (result !== undefined && result !== null)
    for (const row of Array.isArray(result) ? result : [result]) validateFileSaveIntent(row);
  return result;
}

/** Authorize the current document before disclosing this document-local result to any caller. */
export function readFileSaveIntent(
  executor: Db | DbTransaction,
  documentId: string,
  eventId: string
): FileSaveIntentRow | undefined {
  const raw = readFileSaveChecked(`${documentId}/${eventId}`, () =>
    executor
      .select()
      .from(canvasDocFileSaveIntents)
      .where(
        and(
          eq(canvasDocFileSaveIntents.documentId, documentId),
          eq(canvasDocFileSaveIntents.eventId, eventId)
        )
      )
      .get()
  );
  return raw ? validateFileSaveIntent(raw) : undefined;
}

/** Every ordinary intent permanently reserves its document-local event UUID, including terminal refusals. */
export function requireFileSaveUuidVacant(
  tx: DbTransaction,
  documentId: string,
  eventId: string
): void {
  if (readFileSaveIntent(tx, documentId, eventId))
    throw new Error('Document event UUID is permanently reserved.');
}

/** Scan unresolved and unknown statuses completely; terminal rows are validated on UUID reads. */
export function assertFileSaveAdmission(
  db: Db,
  identity: CanonicalFileIdentity,
  originalIntentId?: string
): void {
  if (db.$client.inTransaction) throw new Error('Filesystem admission inside transaction');
  let cursor: string | undefined,
    count = 0;
  for (;;) {
    const rows = readFileSaveChecked('unresolved', () =>
      db
        .select()
        .from(canvasDocFileSaveIntents)
        .where(
          and(
            or(
              isNull(canvasDocFileSaveIntents.status),
              notInArray(canvasDocFileSaveIntents.status, ['committed', 'no_op', 'failed'])
            ),
            cursor ? gt(canvasDocFileSaveIntents.intentId, cursor) : undefined
          )
        )
        .orderBy(asc(canvasDocFileSaveIntents.intentId))
        .limit(100)
        .all()
    );
    for (const raw of rows) {
      if (++count > 1024) throw new Error('Ordinary save recovery capacity exceeded');
      const row = validateFileSaveIntent(raw);
      if (row.intentId === originalIntentId) continue;
      if (
        row.canonicalPath === identity.canonicalPath ||
        (row.beforeDevice === identity.device && row.beforeInode === identity.inode) ||
        (row.replacementDevice === identity.device && row.replacementInode === identity.inode)
      )
        throw new FileSaveWriteFencedError();
    }
    if (rows.length < 100) return;
    cursor = rows[rows.length - 1]!.intentId;
  }
}

/** Same-transaction closure gate: terminal history never prevents removing a document. */
export function readDocumentFileSaveCloseBlocker(
  executor: Db | DbTransaction,
  documentId: string
): FileSaveIntentRow | undefined {
  const raw = readFileSaveChecked('closing-document', () =>
    executor
      .select()
      .from(canvasDocFileSaveIntents)
      .where(
        and(
          eq(canvasDocFileSaveIntents.documentId, documentId),
          or(
            isNull(canvasDocFileSaveIntents.status),
            notInArray(canvasDocFileSaveIntents.status, ['committed', 'no_op', 'failed'])
          )
        )
      )
      .limit(1)
      .get()
  );
  return raw ? validateFileSaveIntent(raw) : undefined;
}
