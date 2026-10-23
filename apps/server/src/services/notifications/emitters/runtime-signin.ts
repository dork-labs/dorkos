/**
 * Persist and escalate sign-in episodes per account. Boot retires old episodes
 * that the current process cannot resolve, without claiming the account works.
 * @module services/notifications/emitters/runtime-signin
 */
import { isSigninFailing, setRuntimeSigninSink } from '../../observability/index.js';
import path from 'node:path';
import { configManager } from '../../core/config-manager.js';
import { signinTarget } from '@dorkos/shared/notification-schemas';
import { logger } from '../../../lib/logger.js';
import { notify, resolveStanding, unresolvedStanding } from '../notification-service.js';
import { armEscalation } from '../escalation-service.js';

/**
 * Say something when a runtime's sign-in stops working, and stop saying it when
 * it works again — and, first, close the rows a restart orphaned.
 *
 * @returns An unsubscribe function, matching the other emitters here.
 */
export function watchRuntimeSigninFailures(): () => void {
  // Read the orphans BEFORE the sink exists, so the list cannot contain a raise
  // this process made: `noteSigninFailure` returns early while no sink is
  // installed, which is the same reason nothing is claimed before boot wires
  // one. See `retireOrphanedEpisodes` below.
  //
  // Wrapped, because this is the composition root's thread: a locked database
  // (SQLITE_BUSY, another process mid-write at exactly this moment) would
  // otherwise throw out of `index.ts`'s boot sequence and take the whole
  // installation of this watch with it — leaving every runtime UNWATCHED over a
  // tidy-up that was optional. A repair that could not run is worth a log line;
  // it is not worth the feature it is repairing.
  const orphaned = readOrphanedEpisodes();

  setRuntimeSigninSink(({ runtime, accountRoot, edge, since }) => {
    const account = accountRoot ? { accountRoot, accountName: signinAccountName(accountRoot) } : {};

    if (edge === 'failing') {
      void notify('signin.required', { runtime, since, ...account });
      // Outside the fire-and-forget above, and never awaiting it: the row is
      // what the operator finds later, the clock is what reaches them tonight,
      // and a store that could not write must not also cost the phone leg.
      armEscalation('signin.required', { runtime, since, ...account });
      return;
    }
    void resolveStanding(
      'signin.required',
      { runtime, since, ...account, clearedAt: new Date().toISOString() },
      { outcome: 'cleared' }
    );
  });

  void retireOrphanedEpisodes(orphaned);
  return () => setRuntimeSigninSink(null);
}

/**
 * The unresolved raise rows, or none when the store could not be asked.
 *
 * @returns What {@link unresolvedStanding} found, or an empty list on any read
 *   failure — boot carries on either way.
 */
function readOrphanedEpisodes(): OrphanedEpisode[] {
  try {
    return unresolvedStanding('signin.required');
  } catch (err) {
    logger.warn('[Runtimes] Could not look for sign-in episodes left open by a restart', { err });
    return [];
  }
}

/** One raise row this process found with nothing after it. */
interface OrphanedEpisode {
  /** The runtime it is about — `subjectId` on the row. */
  subjectId: string;
  /** When the row was written. Always present; it is a column. */
  createdAt: string;
  /** What the row was written from, when it can still be read. */
  payload: unknown;
}

/**
 * Close the episodes a restart orphaned, leaving current live episodes alone.
 * Old rows without an episode stamp use their own creation time. Each write is
 * isolated so a locked row cannot suppress other repairs or watch installation.
 * @param orphaned - Unresolved rows captured before installing this process's sink.
 */
async function retireOrphanedEpisodes(orphaned: OrphanedEpisode[]): Promise<void> {
  for (const { subjectId, createdAt, payload } of orphaned) {
    const { runtime, accountRoot } = signinTarget(subjectId);
    if (isSigninFailing(runtime, accountRoot)) continue;
    const since = episodeStart(payload) ?? createdAt;
    logger.info('[Runtimes] Closing a sign-in episode a restart left open', {
      runtime: subjectId,
    });
    try {
      await resolveStanding(
        'signin.required',
        { runtime, accountRoot, since, clearedAt: new Date().toISOString(), closedAtBoot: true },
        { outcome: 'cleared' }
      );
    } catch (err) {
      logger.warn('[Runtimes] Could not close a sign-in episode left open by a restart', {
        err,
        runtime: subjectId,
      });
    }
  }
}

/**
 * The episode identity stored on a raise row, or `null` when the row does not
 * carry one this process can read.
 *
 * Narrowed rather than cast: the payload comes back off disk as `unknown`, and
 * it may have been written by an older version of this file — the rows DOR-1654
 * wrote carry `{ runtime }` and nothing else. `null` is normal, not exceptional;
 * the caller falls back to the row's `createdAt`.
 */
function episodeStart(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const since = (payload as { since?: unknown }).since;
  return typeof since === 'string' && since.length > 0 ? since : null;
}

/** Resolve the configured label without inspecting a sign-in or starting a command. */
function signinAccountName(root: string): string {
  try {
    const account = configManager
      .get('runtimes')
      ?.claudeCode?.accounts.find((row) => path.resolve(row.path) === path.resolve(root));
    if (account?.label) return account.label;
  } catch {
    /* A missing config must not suppress the notice. */
  }
  return path.basename(root) === '.claude' ? 'Main' : path.basename(root);
}
