/**
 * Account usage in the client (spec `claude-account-ui` §6.0): one cache entry
 * per runtime, `accountKeys.usage(runtime)`, holding that runtime's
 * `AccountUsage[]`.
 *
 * The entry is SEEDED from data already on the wire: the session list envelope
 * carries `accountUsage` for every account on the page ({@link seedAccountUsage}),
 * and the global `account_usage` event keeps it current (`useAccountUsageSync`).
 * So an open session has its account's usage with no request of its own, and
 * {@link useAccountUsage} asks the route only when the seed lacks the account
 * it was asked about, or when a caller insists (Settings → Runtimes).
 *
 * Lives in `shared/` because session rows (`entities/session`) read it and the
 * session-list query in that entity writes it.
 *
 * @module shared/model/server-config/use-account-usage
 */
import { useMemo } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { useTransport } from '../TransportContext';
import { accountKeys } from './query-keys';

/** How long a usage read stays fresh. */
const ACCOUNT_USAGE_STALE_TIME_MS = 60_000;

/** The identity a record is upserted by: its runtime, then its id, else its path. */
function recordKey(usage: AccountUsage): string {
  return `${usage.runtime}\u0000${usage.accountId ?? usage.path}`;
}

/** Milliseconds of `updatedAt`, with `null` (and anything unreadable) losing to any time. */
function updatedAtMs(usage: AccountUsage): number {
  const ms = usage.updatedAt === null ? Number.NaN : Date.parse(usage.updatedAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** Whichever of two readings of one account is newer; `incoming` wins a tie. */
function newer(current: AccountUsage | undefined, incoming: AccountUsage): AccountUsage {
  if (current && updatedAtMs(current) > updatedAtMs(incoming)) return current;
  return incoming;
}

/**
 * Upsert usage records into a list without ever going back in time.
 *
 * A record is matched by `(runtime, accountId ?? path)`, so the implicit
 * `default` account of two runtimes stays two records, and an unregistered
 * root is matched by its path. A record already in `prev` whose `updatedAt` is
 * newer than the incoming one is kept (times compared as dates; `null` loses).
 * New accounts are appended in the order they arrive.
 *
 * @param prev - The records held now.
 * @param incoming - The records just read.
 * @returns A new list; neither input is changed.
 */
export function mergeAccountUsage(
  prev: readonly AccountUsage[],
  incoming: readonly AccountUsage[]
): AccountUsage[] {
  const merged = [...prev];
  const index = new Map(merged.map((usage, i) => [recordKey(usage), i]));
  for (const usage of incoming) {
    const key = recordKey(usage);
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, merged.length);
      merged.push(usage);
    } else {
      merged[at] = newer(merged[at], usage);
    }
  }
  return merged;
}

/**
 * Write usage records into each runtime's cache entry without a request.
 *
 * The records are grouped by `runtime` and merged into
 * `accountKeys.usage(runtime)` with {@link mergeAccountUsage}, creating the
 * entry when it is absent. The entry keeps the time it was last FETCHED (never,
 * for a new one), so a seed never makes a stale read look fresh: a caller that
 * does need the route still gets it.
 *
 * @param queryClient - The client whose cache to write.
 * @param records - Usage records already on the wire, such as the session list's `accountUsage`.
 */
export function seedAccountUsage(queryClient: QueryClient, records: readonly AccountUsage[]): void {
  const byRuntime = new Map<string, AccountUsage[]>();
  for (const usage of records) {
    const group = byRuntime.get(usage.runtime);
    if (group) group.push(usage);
    else byRuntime.set(usage.runtime, [usage]);
  }
  for (const [runtime, group] of byRuntime) {
    upsertAccountUsage(queryClient, runtime, group);
  }
}

/**
 * Merge records into one runtime's cache entry, keeping the entry's fetch time.
 *
 * @internal Shared by {@link seedAccountUsage} and `useAccountUsageSync`.
 */
export function upsertAccountUsage(
  queryClient: QueryClient,
  runtime: string,
  records: readonly AccountUsage[]
): void {
  const key = accountKeys.usage(runtime);
  const fetchedAt = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
  queryClient.setQueryData<AccountUsage[]>(key, (prev) => mergeAccountUsage(prev ?? [], records), {
    updatedAt: fetchedAt,
  });
}

/** Options for {@link useAccountUsage}. */
export interface UseAccountUsageOptions {
  /** The registry id of the account the caller shows; fetched when the cache lacks it. */
  accountId?: string | null;
  /** The path of the account the caller shows; fetched when the cache lacks it. */
  path?: string | null;
  /** Ask the route even when the cache has the account (Settings → Runtimes while open). */
  fetch?: boolean;
}

/** What {@link useAccountUsage} reports. */
export interface AccountUsageView {
  /** Records by registry id; a record with no id is left out. */
  byId: Map<string, AccountUsage>;
  /** Records by account path. */
  byPath: Map<string, AccountUsage>;
  /** True while the first request for this runtime is in flight. */
  isLoading: boolean;
}

const EMPTY: readonly AccountUsage[] = [];

/**
 * Read one runtime's account usage.
 *
 * Reads the cache the session list seeds, so it normally makes no request.
 * `transport.getAccountUsage(runtime)` runs only when `opts.accountId` or
 * `opts.path` names an account the cache lacks, or when `opts.fetch` is true.
 *
 * @param runtime - The runtime slug, or nothing while it is unknown (reads nothing).
 * @param opts - The account the caller shows, and whether to fetch regardless.
 */
export function useAccountUsage(
  runtime: string | null | undefined,
  opts: UseAccountUsageOptions = {}
): AccountUsageView {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const key = accountKeys.usage(runtime ?? '');

  // Read synchronously so the very first render already knows whether the
  // seed covers the account; the query below subscribes to the same entry, so
  // a later seed or event re-renders this and the answer is recomputed.
  const held = runtime ? queryClient.getQueryData<AccountUsage[]>(key) : undefined;
  const { accountId, path } = opts;
  const lacksAccount =
    (accountId != null && !held?.some((usage) => usage.accountId === accountId)) ||
    (accountId == null && path != null && !held?.some((usage) => usage.path === path));

  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<AccountUsage[]> => {
      const { accounts } = await transport.getAccountUsage(runtime!);
      // The route answers for every account of the runtime, so its list is the
      // list; only an account an event updated since keeps that newer reading.
      const current = queryClient.getQueryData<AccountUsage[]>(key) ?? [];
      const currentByKey = new Map(current.map((usage) => [recordKey(usage), usage]));
      return accounts.map((usage) => newer(currentByKey.get(recordKey(usage)), usage));
    },
    staleTime: ACCOUNT_USAGE_STALE_TIME_MS,
    enabled: !!runtime && (opts.fetch === true || lacksAccount),
    // Localhost answers whatever the wifi is doing (see `useConfig`, DOR-2103).
    networkMode: 'always',
  });
  const records = query.data ?? EMPTY;

  return useMemo(() => {
    const byId = new Map<string, AccountUsage>();
    const byPath = new Map<string, AccountUsage>();
    for (const usage of records) {
      if (usage.accountId !== null) byId.set(usage.accountId, usage);
      byPath.set(usage.path, usage);
    }
    return { byId, byPath, isLoading: query.isLoading };
  }, [records, query.isLoading]);
}
