/**
 * Keep cached account usage current from the global event stream (spec
 * `claude-account-ui` §6.0).
 *
 * @module shared/model/server-config/use-account-usage-sync
 */
import { useQueryClient } from '@tanstack/react-query';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { useEventSubscription } from '../event-stream-context';
import { accountKeys } from './query-keys';
import { upsertAccountUsage } from './use-account-usage';

/**
 * Upsert every `account_usage` event into its runtime's cached usage, newer
 * reading wins, with no request.
 *
 * A runtime nothing has cached is left alone: an event is one account, and
 * creating an entry from it would make a one-account list look like the whole
 * runtime to a reader that would otherwise have fetched. Mount once, in
 * `AppShell`, beside the config sync.
 */
export function useAccountUsageSync(): void {
  const queryClient = useQueryClient();

  useEventSubscription('account_usage', (data) => {
    const usage = data as AccountUsage | null;
    if (!usage || typeof usage.runtime !== 'string') return;
    if (queryClient.getQueryData(accountKeys.usage(usage.runtime)) === undefined) return;
    upsertAccountUsage(queryClient, usage.runtime, [usage]);
  });
}
