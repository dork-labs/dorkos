/** Private original-save scope provenance; never an alias for current authorization. */
import { z } from 'zod';
import { eq, canvasDocIdentityIntents, type Db, type DbTransaction } from '@dorkos/db';
import type { DocSourceDescriptor } from '../../doc-source-policy.js';
import { readChecked } from '../../store-json.js';

const sessionScope = z
  .string()
  .regex(/^session:[^\s:]+$/u)
  .max(400);
const MoveSchema = z
  .object({
    documentId: z.string().min(1),
    fromScope: sessionScope,
    toScope: sessionScope,
    sourceId: z.string().min(1),
    sourceGeneration: z.literal('ownership'),
    evidence: z.object({ sourceKey: z.string().nullable() }).strict(),
    status: z.literal('applied'),
    errorCode: z.null(),
  })
  .strict();
const MAX_MOVES = 32;

/** Admit only an exact source or this same document's complete, unique applied scope chain. */
export function sameOriginalFileSaveSource(
  executor: Db | DbTransaction,
  original: DocSourceDescriptor,
  current: DocSourceDescriptor
): boolean {
  const { scope: from, ...oldFields } = original;
  const { scope: to, ...newFields } = current;
  const keys = Object.keys(oldFields) as Array<keyof typeof oldFields>;
  if (
    keys.length !== Object.keys(newFields).length ||
    keys.some((key) => oldFields[key] !== newFields[key])
  )
    return false;
  if (from === to) return true;
  if (!sessionScope.safeParse(from).success || !sessionScope.safeParse(to).success) return false;
  const rows = readChecked('canvas_doc_identity_intents', original.id, () =>
    executor
      .select({
        documentId: canvasDocIdentityIntents.documentId,
        fromScope: canvasDocIdentityIntents.fromScope,
        toScope: canvasDocIdentityIntents.toScope,
        sourceId: canvasDocIdentityIntents.sourceId,
        sourceGeneration: canvasDocIdentityIntents.sourceGeneration,
        evidence: canvasDocIdentityIntents.evidence,
        status: canvasDocIdentityIntents.status,
        errorCode: canvasDocIdentityIntents.errorCode,
      })
      .from(canvasDocIdentityIntents)
      .where(eq(canvasDocIdentityIntents.documentId, original.id))
      .limit(MAX_MOVES + 1)
      .all()
  );
  if (rows.length === 0 || rows.length > MAX_MOVES) return false;
  const moves = new Map<string, string>();
  for (const raw of rows) {
    const parsed = MoveSchema.safeParse(raw);
    if (!parsed.success) return false;
    const move = parsed.data;
    if (
      move.documentId !== original.id ||
      move.sourceId !== original.id ||
      move.evidence.sourceKey !== original.sourceIdentity ||
      move.fromScope === move.toScope ||
      moves.has(move.fromScope)
    )
      return false;
    moves.set(move.fromScope, move.toScope);
  }
  // Reject corrupt disconnected cycles as well as a cycle on the requested chain.
  for (const start of moves.keys()) {
    const seen = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      cursor = moves.get(cursor);
    }
  }
  const visited = new Set<string>();
  let scope = from;
  while (!visited.has(scope)) {
    visited.add(scope);
    const next = moves.get(scope);
    if (!next) return scope === to;
    // Even at the requested destination a retained later move must not be ignored.
    scope = next;
  }
  return false;
}
