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
import type { LedgerObservation } from '@dorkos/shared/account-usage';
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
