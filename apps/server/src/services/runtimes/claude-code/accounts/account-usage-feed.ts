/**
 * The one door Claude Code's usage readings take into the account usage store.
 *
 * Both feed points (the SDK `rate_limit_event` and the per-turn usage call) run
 * inside a turn, so this never waits and never throws: without an installed
 * store it does nothing, and the store merges in memory and writes later.
 *
 * A session's readings belong to the folder it actually runs in:
 * `launchedAccountRoot` (what this process launched it on), else the
 * disk-derived `accountRoot`, else the root a new launch would take. The store
 * maps that folder to a registered account, the machine-wide `default`, or a
 * memory-only record.
 *
 * @module services/runtimes/claude-code/accounts/account-usage-feed
 */
import {
  subscriptionUsageOf,
  type AccountUsage,
  type LedgerObservation,
} from '@dorkos/shared/account-usage';
import type { UsageStatus } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import type { AccountUsageMeta } from '../../../core/usage/account-usage-types.js';
import { getAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import type { AgentSession } from '../agent-types.js';
import { resolveActiveClaudeRoot } from '../claude-config-dir.js';

/**
 * Record one session's usage readings against the account it runs on.
 *
 * @param session - The session the readings came from.
 * @param observations - Window readings, already in the ledger's units.
 * @param meta - The subscription type and any account facts.
 */
export function recordSessionUsage(
  session: Pick<AgentSession, 'launchedAccountRoot' | 'accountRoot'>,
  observations: readonly LedgerObservation[],
  meta?: AccountUsageMeta
): void {
  const store = getAccountUsageStore();
  if (!store) return;
  if (observations.length === 0 && meta?.subscriptionType === undefined) return;
  try {
    const root = session.launchedAccountRoot ?? session.accountRoot ?? resolveActiveClaudeRoot();
    store.record('claude-code', { path: root }, observations, meta);
  } catch (err) {
    logger.warn('[account-usage] could not record a session usage reading', { err: String(err) });
  }
}

/**
 * The account usage of the account a session runs on, from the store's memory
 * (no disk work), or `undefined` without an installed store. Resolved from the
 * same folder {@link recordSessionUsage} records under, so a session reads back
 * exactly the account its readings went to.
 *
 * @param session - The session whose account is wanted.
 */
export function peekSessionAccountUsage(
  session: Pick<AgentSession, 'launchedAccountRoot' | 'accountRoot'>
): AccountUsage | undefined {
  const store = getAccountUsageStore();
  if (!store) return undefined;
  try {
    const root = session.launchedAccountRoot ?? session.accountRoot ?? resolveActiveClaudeRoot();
    return store.peekByRoot('claude-code', root);
  } catch (err) {
    logger.debug('[account-usage] could not read a session account usage', { err: String(err) });
    return undefined;
  }
}

/**
 * A session's subscription `usage` as the store has it: its account's binding
 * window ({@link subscriptionUsageOf}), or `undefined` while the store holds
 * no plan window for the account (callers then keep the session's own last
 * reading, the fallback spec §6 U allows until the store has a record), and
 * always `undefined` for a session billed per token
 * ({@link isSubscriptionSession}): its folder's windows are not its usage.
 *
 * @param session - The session whose usage is wanted.
 */
export function sessionSubscriptionUsage(
  session: Pick<
    AgentSession,
    'launchedAccountRoot' | 'accountRoot' | 'launchedPerToken' | 'lastSubscriptionUsage'
  >
): UsageStatus | undefined {
  if (!isSubscriptionSession(session)) return undefined;
  const account = peekSessionAccountUsage(session);
  return account ? subscriptionUsageOf(account) : undefined;
}

/**
 * Whether a session bills against its account's subscription: it has had a
 * subscription reading of its own, or its launch injected neither a stored API
 * key nor DorkOS credits. A session never launched here and with no reading
 * of its own is not known to be on a subscription.
 *
 * @param session - The session.
 */
export function isSubscriptionSession(
  session: Pick<AgentSession, 'launchedPerToken' | 'lastSubscriptionUsage'>
): boolean {
  if (session.lastSubscriptionUsage?.kind === 'subscription') return true;
  return session.launchedPerToken === false;
}

/** Called with a session id, the folder a launch settled it on, and whether it bills per token. */
type AccountLaunchListener = (sessionId: string, root: string, perToken: boolean) => void;

const accountLaunchListeners = new Set<AccountLaunchListener>();

/**
 * Listen for launches settling which account a session runs on. The session
 * status hydration re-stamps a session's account usage from here, because a
 * new session's per-send account hint is only known once its first send
 * launches.
 *
 * @param listener - Called with the session id and the launch's account folder.
 * @returns An unsubscribe function.
 */
export function onSessionAccountLaunched(listener: AccountLaunchListener): () => void {
  accountLaunchListeners.add(listener);
  return () => {
    accountLaunchListeners.delete(listener);
  };
}

/**
 * Tell listeners that a launch settled a session's account. Never throws into
 * the launch.
 *
 * @param sessionId - The session that launched.
 * @param root - The account folder the launch runs on.
 * @param perToken - Whether the launch injected a stored API key or credits.
 */
export function noteSessionAccountLaunched(
  sessionId: string,
  root: string,
  perToken: boolean
): void {
  for (const listener of accountLaunchListeners) {
    try {
      listener(sessionId, root, perToken);
    } catch (err) {
      logger.warn('[account-usage] an account-launch listener failed', { err: String(err) });
    }
  }
}
