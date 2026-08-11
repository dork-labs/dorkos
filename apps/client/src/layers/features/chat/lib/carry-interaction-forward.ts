/**
 * A rekeyed session keeps the interaction the operator performed on it.
 *
 * A conversation created by its first message is addressed by a throwaway
 * client UUID until the runtime answers with its own canonical id. The send
 * that created it records an interaction (`use-session-submit`), and it can
 * only record it under the id it had at the time — so without this the record
 * names a session that no longer exists, and Today, which walks the session
 * list, has no row to hang it on. The operator writes a message, walks away,
 * and the conversation they just started is not in Today.
 *
 * The rekey lands by two routes and both call this: the 202 can resolve the
 * canonical id directly, or the server can re-announce it afterwards on the
 * global stream (`useSessionRekeyRedirect`, the common claude-code path). Both
 * are idempotent here.
 *
 * It lives in `features/chat` rather than beside the migrations it accompanies
 * in `entities/session` because an entity may not import a sibling entity, and
 * the record belongs to `entities/interactions`.
 *
 * @module features/chat/lib/carry-interaction-forward
 */
import { interactionKey, useInteractionStore } from '@/layers/entities/interactions';

/**
 * Move a retired session's interaction record onto its canonical id.
 *
 * The retired record is left where it is rather than deleted: the stale entry
 * names an id no list will ever contain again, and it ages out of the
 * 500-record cap on its own.
 *
 * **`mergeUsage`, not `recordOpened`, and the difference is the count.** Since
 * P3.3 a record carries a use count as well as an instant, and `recordOpened`
 * advances that count — so replaying the retired instant through it would give
 * the canonical id one use for a conversation the operator had used more, while
 * the real count stayed stranded on an id nothing reads. `mergeUsage` folds
 * history recorded elsewhere in, taking the LARGER of each field, which is
 * exactly this: the same act arriving under a new name.
 *
 * Its max-take is also what makes this safe to run twice, and it has to be.
 * Both rekey routes call it — the 202 that resolves a canonical id and the
 * retire announce that follows — and the announce can arrive after the URL has
 * rekeyed and a second message has already recorded against the canonical id.
 * Taking the maximum means a later, truer record is never dragged backwards,
 * so no hand-rolled guard is needed here.
 *
 * @param retiredSessionId - The id the send was made under.
 * @param canonicalSessionId - The id the runtime settled on.
 */
export function carryInteractionForward(
  retiredSessionId: string,
  canonicalSessionId: string
): void {
  if (retiredSessionId === canonicalSessionId) return;
  const { opened, counts, mergeUsage } = useInteractionStore.getState();
  const retiredKey = interactionKey('session', retiredSessionId);
  const lastUsedAt = Date.parse(opened[retiredKey] ?? '');
  // Nothing was ever recorded under the retired id, so there is nothing to
  // carry. A rekey is the server's event, not the operator's: it must not
  // invent a record for a conversation nobody wrote in.
  if (Number.isNaN(lastUsedAt)) return;
  mergeUsage([
    {
      key: interactionKey('session', canonicalSessionId),
      lastUsedAt,
      useCount: counts[retiredKey] ?? 1,
    },
  ]);
}
