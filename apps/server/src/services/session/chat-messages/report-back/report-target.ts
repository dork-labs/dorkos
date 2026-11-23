import type {
  SessionStartedByStore,
  StartedByRecord,
} from '../../origin/session-started-by-store.js';

/** The start record behind a chat, past the copies an account carry made of it (bounded walk). */
function originalStartOf(
  store: SessionStartedByStore | undefined,
  sessionId: string
): StartedByRecord | null {
  let record = store?.get(sessionId) ?? null;
  for (let n = 0; record?.carried && record.startedBySessionId && n < 10; n += 1)
    record = store?.get(record.startedBySessionId) ?? null;
  return record;
}

/** Follow only the server's durable carried-chat relations, with a bounded walk. */
export function reportTargetFromStore(
  store: SessionStartedByStore | undefined,
  sessionId: string
): { parentSessionId: string } | null {
  const record = originalStartOf(store, sessionId);
  if (!record || record.kind !== 'chat' || !record.reportBack || !record.startedBySessionId)
    return null;
  let parentSessionId = record.startedBySessionId;
  for (let n = 0; n < 10; n += 1) {
    const next = store?.carriedSuccessorOf(parentSessionId);
    if (!next) break;
    parentSessionId = next;
  }
  return { parentSessionId };
}

/**
 * When a spin-off was first started (epoch ms), from the server's own start record, past any
 * account carry: a carried copy is the same work, started when the original was. Null when no
 * start is recorded. A seat that moved takes a report only from a spin-off started at or before
 * the move (DOR-3753), and this is the start it is checked against.
 *
 * @param store - The started-by store.
 * @param sessionId - The spin-off.
 */
export function reportStartedAtFromStore(
  store: SessionStartedByStore | undefined,
  sessionId: string
): number | null {
  const record = originalStartOf(store, sessionId);
  const at = record ? Date.parse(record.createdAt) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}
