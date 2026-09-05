/**
 * "The read has not answered yet", asked in the one way that survives the
 * persisted cache (DOR-1646).
 *
 * @module shared/model/query/use-pending-read
 */
import { useIsRestoring } from '@tanstack/react-query';

/**
 * Whether a query's first answer is still outstanding.
 *
 * **`isLoading` alone is not that question, and the difference has shipped
 * twice.** TanStack's `isLoading` is `isPending && isFetching`, and while
 * `PersistQueryClientProvider` restores the cache out of `localStorage`
 * (`shared/lib/query-persister.ts`) every query is PAUSED — pending, but not
 * fetching. `isLoading` therefore reads FALSE with nothing in hand, and whatever
 * the caller renders for "no data" renders for a beat over an install that has
 * plenty:
 *
 * - the first-run wizard, shown to a returning user who had dismissed
 *   onboarding weeks earlier — and writing a fresh `startedAt` on the way past
 *   (DOR-1365 §3.2);
 * - "Nobody to show yet." over a full roster, on `/team` (DOR-1419).
 *
 * Both were fixed the same way and separately, which is what made a third one a
 * matter of time. This is that fix, named once.
 *
 * `useIsRestoring` is false wherever there is no persister — the Obsidian embed
 * included — so this costs those surfaces nothing.
 *
 * **Not for a query that can be disabled.** A disabled query is pending forever
 * and is not waiting on anything; ask whether the answer has ARRIVED instead
 * (`data === undefined && !isError`, gated on the thing that enables it — see
 * `features/agent-creation/model/use-offer-schedules.ts`).
 *
 * @param isLoading - The query's own `isLoading`. Pass that rather than
 *   `isPending`: outside the restore window they agree, and `isPending` alone
 *   would also report true for a disabled query this hook cannot see.
 * @returns True while the first answer is still outstanding.
 */
export function usePendingRead(isLoading: boolean): boolean {
  const isRestoring = useIsRestoring();
  return isLoading || isRestoring;
}
