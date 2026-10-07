import { eventFanOut } from '../../core/event-fan-out.js';
import type { OwnedBrowserGrants } from './grants.js';

/** Owned original room-loss subscription; event payloads only select stored grants for real scope rechecks. */
export class BrowserGrantScopeLoss {
  private closed = false;
  private readonly unsubscribe: () => void;
  constructor(
    bank: Pick<OwnedBrowserGrants, 'scopeRemoved'>,
    events: Pick<typeof eventFanOut, 'subscribe'> = eventFanOut
  ) {
    const remove = bank.scopeRemoved.bind(bank),
      subscribe = events.subscribe.bind(events);
    this.unsubscribe = subscribe((event, data) => {
      if (this.closed || event !== 'room_member_removed' || !data || typeof data !== 'object')
        return;
      const { roomId, authorId } = data as Record<string, unknown>;
      if (typeof roomId !== 'string' || typeof authorId !== 'string') return;
      // Capture original scalar values; a later listener cannot retarget this denial via a live payload.
      remove(Object.freeze({ kind: 'room', roomId }), authorId);
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
  }
}
