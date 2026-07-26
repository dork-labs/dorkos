/**
 * The composer's clear for a native command that finishes asynchronously.
 *
 * `NativeCommandResult.ran` means "the dispatch started", not "the action
 * happened" — DOR-480 added `confirmed` for exactly that gap and settled the
 * QUEUE's undo on it. The composer never got the same treatment: a `/compact
 * focus on the API changes` typed mid-stream reported `ran: true`, the composer
 * emptied, the trigger then came back `SESSION_LOCKED`, and the person was left
 * with a toast telling them to try again and no instructions to try it with.
 *
 * So the clear waits on the same signal the queue does. Both send paths — the
 * queue decision and the plain Enter — route through here, so there is one rule
 * rather than two that can drift.
 *
 * @module features/chat/lib/clear-composer-on-confirmed
 */
import { useSessionChatStore } from '@/layers/entities/session';

/**
 * Empty a session's composer once `confirmed` settles true, and only if it
 * still holds the text that was dispatched.
 *
 * The unchanged check is not paranoia: the wait is a full request round-trip,
 * which is long enough to start typing the next message into. Clearing blindly
 * would swap one kind of loss for another.
 *
 * @param sessionId - The session whose composer was dispatched from. Pinned, so
 *   a switch mid-flight cannot empty the composer the person moved to.
 * @param dispatched - The exact text handed to the command.
 * @param confirmed - The command's settle signal. Never rejects (see
 *   `NativeCommandResult.confirmed`), but a rejection is treated as "not
 *   confirmed" so an unexpected one keeps the text rather than eating it.
 */
export function clearComposerOnConfirmed(
  sessionId: string | null,
  dispatched: string,
  confirmed: Promise<boolean>
): void {
  if (!sessionId) return;
  void confirmed.then(
    (accepted) => {
      if (!accepted) return;
      const store = useSessionChatStore.getState();
      if (store.getSession(sessionId).input.trim() !== dispatched.trim()) return;
      store.updateSession(sessionId, { input: '' });
    },
    () => {
      // Not confirmed — keep the text. Nothing else to do.
    }
  );
}
