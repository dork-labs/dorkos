/** Shared by the event-log history tests. */
import type { SessionEvent } from '@dorkos/shared/session-stream';

/** Shorthand for building seq'd events without repeating the cast dance. */
export function events(...list: SessionEvent[]): SessionEvent[] {
  return list;
}
