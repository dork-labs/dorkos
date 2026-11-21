import type { SessionStartedByStore } from '../../origin/session-started-by-store.js';

/** Follow only the server's durable carried-chat relations, with a bounded walk. */
export function reportTargetFromStore(
  store: SessionStartedByStore | undefined,
  sessionId: string
): { parentSessionId: string } | null {
  let record = store?.get(sessionId) ?? null;
  for (let n = 0; record?.carried && record.startedBySessionId && n < 10; n += 1)
    record = store?.get(record.startedBySessionId) ?? null;
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
