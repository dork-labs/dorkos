/**
 * How the account usage store turns its in-memory records into the wire shape
 * (`AccountUsage`): pure functions of the resolved accounts, the records and
 * the clock, split out of `account-usage-store.ts`.
 *
 * @module services/core/usage/account-usage-view
 */
import {
  resolveAccountColor,
  toAccountUsage,
  type AccountUsage,
} from '@dorkos/shared/account-usage';
import type { UsageRecord } from './account-usage-types.js';
import type { RuntimeAccount } from './runtime-accounts.js';

/**
 * One resolved account's usage, from its record (if any).
 *
 * @param account - The account.
 * @param records - The store's records, by map key.
 * @param now - The moment to read at.
 */
export function usageOfAccount(
  account: RuntimeAccount,
  records: ReadonlyMap<string, UsageRecord>,
  now: Date
): AccountUsage {
  const record =
    account.ledgerId !== null
      ? records.get(`${account.runtime}:${account.ledgerId}`)
      : account.canonicalPath !== null
        ? records.get(`${account.runtime}@${account.canonicalPath}`)
        : undefined;
  return toAccountUsage(
    record?.ledger ?? null,
    {
      runtime: account.runtime,
      accountId: account.routable ? account.id : null,
      path: account.path ?? '',
      label: account.label,
      color: account.color,
    },
    now,
    record?.subscriptionType ?? null
  );
}

/**
 * A memory-only root's usage: no id, no label, the palette color at `position`.
 *
 * @param record - The memory-only record.
 * @param position - Its place in its runtime's list, for the color.
 * @param now - The moment to read at.
 */
export function memoryUsage(record: UsageRecord, position: number, now: Date): AccountUsage {
  return toAccountUsage(
    record.ledger,
    {
      runtime: record.runtime,
      accountId: null,
      path: record.path,
      label: null,
      color: resolveAccountColor(null, position),
    },
    now,
    record.subscriptionType
  );
}

/**
 * The usage a record shows, as its account (or as a memory-only root), or
 * `null` for a file-backed record whose account is no longer resolved.
 *
 * @param record - The record.
 * @param accounts - The resolved accounts.
 * @param records - The store's records, by map key.
 * @param now - The moment to read at.
 */
export function usageOfRecord(
  record: UsageRecord,
  accounts: readonly RuntimeAccount[],
  records: ReadonlyMap<string, UsageRecord>,
  now: Date
): AccountUsage | null {
  if (record.ledgerId !== null) {
    const account = accounts.find(
      (a) => a.runtime === record.runtime && a.ledgerId === record.ledgerId
    );
    return account ? usageOfAccount(account, records, now) : null;
  }
  const account = accounts.find(
    (a) => a.runtime === record.runtime && a.canonicalPath === record.path
  );
  if (account) return usageOfAccount(account, records, now);
  const position = accounts.filter((a) => a.runtime === record.runtime).length;
  return memoryUsage(record, position, now);
}
