/**
 * Fake account rows and usage for the ranking tests: describe each account in
 * one line, and `installStore` serves exactly those through the usage store.
 */
import type { AccountUsage, LedgerRuntime } from '@dorkos/shared/account-usage';
import { setAccountUsageStore } from '../current-usage-store.js';
import type { AccountUsageStore } from '../account-usage-store.js';
import type { RuntimeAccount } from '../runtime-accounts.js';

/** One account, described by what a test cares about. */
export interface Fixture {
  id: string;
  runtime?: LedgerRuntime;
  weekly?: number | null;
  fiveHour?: number | null;
  state?: AccountUsage['state'];
  resetsAt?: string | null;
  routable?: boolean;
  implicit?: boolean;
  /** A registered row with Main's folder: `default` names it. */
  isDefault?: boolean;
  /** A person turned off "Move agents here automatically" on it. */
  noAutoMove?: boolean;
  /** A person let agents pick it by name (DOR-5033). */
  agentsMayPick?: boolean;
  /** Its folder, when not `/accounts/<id>`. */
  folder?: string;
  /** Its comparable folder, when not its folder (`null` for none known). */
  canonicalPath?: string | null;
}

function account(f: Fixture): RuntimeAccount {
  return {
    runtime: f.runtime ?? 'claude-code',
    id: f.id,
    path: f.folder ?? `/accounts/${f.id}`,
    canonicalPath:
      f.canonicalPath !== undefined ? f.canonicalPath : (f.folder ?? `/accounts/${f.id}`),
    label: f.id.toUpperCase(),
    color: '#123456',
    storedColor: '#123456',
    routable: f.routable ?? true,
    implicit: f.implicit ?? false,
    isDefault: f.isDefault ?? f.implicit ?? false,
    ledgerId: f.id,
    ...(f.noAutoMove ? { noAutoMove: true as const } : {}),
    ...(f.agentsMayPick ? { agentsMayPick: true as const } : {}),
  };
}

function usage(f: Fixture): AccountUsage {
  const windows: AccountUsage['windows'] = [];
  const window = (key: string, usedPct: number) => ({
    key,
    label: key,
    usedPct,
    resetsAt: null,
    status: null,
    expired: false,
    observedAt: '2026-09-26T00:00:00.000Z',
    source: 'sdk_event' as const,
  });
  if (f.fiveHour !== undefined && f.fiveHour !== null)
    windows.push(window('five_hour', f.fiveHour));
  if (f.weekly !== undefined && f.weekly !== null) windows.push(window('seven_day', f.weekly));
  const state = f.state ?? (windows.length > 0 ? 'ok' : 'unknown');
  return {
    runtime: f.runtime ?? 'claude-code',
    accountId: f.id,
    path: f.folder ?? `/accounts/${f.id}`,
    label: f.id.toUpperCase(),
    color: '#123456',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows,
    state,
    limit: state === 'limited' ? { window: 'seven_day', resetsAt: f.resetsAt ?? null } : null,
    updatedAt: null,
  };
}

/** Install a store that knows exactly these accounts, in this order. */
export function installStore(fixtures: Fixture[]): void {
  const accounts = fixtures.map(account);
  const byId = new Map(fixtures.map((f) => [`${f.runtime ?? 'claude-code'}:${f.id}`, usage(f)]));
  const store = {
    listAccounts: (runtime?: LedgerRuntime) =>
      accounts.filter((a) => runtime === undefined || a.runtime === runtime),
    usageOfAccount: (a: RuntimeAccount) => byId.get(`${a.runtime}:${a.id}`)!,
  };
  setAccountUsageStore(store as unknown as AccountUsageStore);
}
