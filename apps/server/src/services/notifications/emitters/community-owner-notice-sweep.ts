/**
 * Asks every connected space, in the background, whether someone wants to take over a space
 * this person owns, and tells them once (DOR-2760).
 *
 * The connection list asks the same thing on every read (`routes/community-connections.ts`), but
 * that list is not read while spaces are switched off, so an owner would not hear of a takeover
 * request until they turned spaces back on. This check runs whatever the switch says. It only
 * reads and announces: the announcer's ledger makes each notice news once, whichever path
 * finds it first.
 *
 * @module services/notifications/emitters/community-owner-notice-sweep
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type {
  CommunityConnectionDescriptor,
  CommunityConnectionOwnerNotice,
} from '@dorkos/shared/community-connections';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';
import { ownerNoticeFrom } from '../../communities/remote/community-owner-notice-cache.js';
import { getOwnerNoticeAnnouncer } from './community-owner-replacement.js';
import {
  getRemoteCommunityAdapter,
  getRemoteConnectionStore,
  getRemotePairingService,
} from '../../communities/remote/state.js';

/**
 * How often the background check runs. A takeover request waits days before it can complete, so
 * an hour is prompt, and costs each space two small reads an hour.
 */
export const OWNER_NOTICE_SWEEP_MS = 60 * 60_000;

/** How long after start the first check runs, once the server has settled. */
const FIRST_CHECK_MS = 60_000;

/** What one check reads and who it tells. */
export interface OwnerNoticeSweepDeps {
  /** Every owner's connection, in any state. */
  connections(): Promise<readonly { communityRef: CommunityRef; ownerAuthorId: string }[]>;
  /** The connection's current status, its access re-checked. */
  status(ref: CommunityRef, ownerAuthorId: string): Promise<CommunityConnectionDescriptor>;
  /** What the space tells this owner now, or `undefined` for nothing. */
  notice(
    ref: CommunityRef,
    ownerAuthorId: string
  ): Promise<CommunityConnectionOwnerNotice | undefined>;
  /** Tell the owner, unless they were told before. */
  announce(ref: string, label: string, notice: CommunityConnectionOwnerNotice): Promise<void>;
}

/**
 * Check every connection that may read its space once, one after another. A space that does not
 * answer, or refuses, is skipped until the next check; it never stops the others.
 *
 * @param deps - What to read and who to tell.
 * @returns How many connections carried a notice for their owner.
 */
export async function sweepOwnerNotices(deps: OwnerNoticeSweepDeps): Promise<number> {
  let found = 0;
  for (const { communityRef, ownerAuthorId } of await deps.connections()) {
    try {
      const connection = await deps.status(communityRef, ownerAuthorId);
      if (
        connection.status !== 'connected' ||
        connection.access?.state !== 'verified' ||
        !connection.access.effective.read
      )
        continue;
      const notice = await deps.notice(communityRef, ownerAuthorId);
      if (!notice) continue;
      found++;
      await deps.announce(connection.ref, connection.label, notice);
    } catch (err) {
      logger.debug('[Spaces] Could not check a space for an owner notice', { err });
    }
  }
  return found;
}

/** The production reads: the connection file, the pairing service and each space's adapter. */
function productionDeps(): OwnerNoticeSweepDeps {
  return {
    connections: async () => (await getRemoteConnectionStore().connectionsIfLoaded()) ?? [],
    status: (ref, owner) => getRemotePairingService().status(ref, owner),
    notice: async (ref, owner) =>
      ownerNoticeFrom(await getRemoteCommunityAdapter(ref, owner).ownerReplacementNotice()),
    announce: (ref, label, notice) =>
      getOwnerNoticeAnnouncer(resolveDorkHome()).announce(ref, label, notice),
  };
}

/**
 * A background check. One check at a time: a slow one is never joined by the next.
 *
 * @param deps - What to read and who to tell; production's when omitted.
 * @param intervalMs - How often to check.
 */
export function createOwnerNoticeSweep(
  deps: OwnerNoticeSweepDeps = productionDeps(),
  intervalMs = OWNER_NOTICE_SWEEP_MS
): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let first: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void sweepOwnerNotices(deps)
      .catch(() => 0)
      .finally(() => {
        running = false;
      });
  };
  return {
    start() {
      if (timer) return;
      // A first check soon after start, so a restart never delays a notice by a whole interval.
      first = setTimeout(run, FIRST_CHECK_MS);
      first.unref?.();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = undefined;
      timer = undefined;
    },
  };
}

/**
 * The server's background check, started and stopped beside the remote room runtime. It runs
 * whether spaces are switched on or off.
 */
export const ownerNoticeSweep = createOwnerNoticeSweep();
