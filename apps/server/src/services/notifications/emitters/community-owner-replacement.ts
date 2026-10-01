/**
 * Tells a community's owner, once, that someone asked the host to make someone else the owner,
 * and once more if that request completes (DOR-2543).
 *
 * The seam is the owner's connection list: the local server reads each Community's notice there
 * (`community-owner-notice-cache.ts`), and only the owner's own connection ever carries one. Each
 * notice that list shows is handed here, every read, and this decides whether it is news.
 *
 * **Why a ledger beside the registry's dedupe.** The registry dedupes against the notifications
 * table, and that table keeps 30 days and 1,000 rows. A request can stay open for months (the
 * Community's longest wait plus its 14-day claim window), so the table alone would announce the
 * same request again once its row aged out. The ledger is a small file of what was announced,
 * kept beside the rest of DorkOS's data like `update-installed.ts`'s, so "once" survives a
 * restart, an update, and the table's pruning. The registry's own window still guards two reads
 * racing each other.
 *
 * @module services/notifications/emitters/community-owner-replacement
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import type { CommunityConnectionOwnerNotice } from '@dorkos/shared/community-connections';
import { logger } from '../../../lib/logger.js';
import { notify } from '../notification-service.js';
import type { NotificationPayload } from '../notification-registry.js';

/** Where announced requests are remembered, under the data directory. */
export const OWNER_NOTICE_LEDGER_FILE = path.join('state', 'community-owner-notices.json');

/** Far more than any one person's open and recent requests; old keys fall off the front. */
const MAX_REMEMBERED = 200;

type Payload = NotificationPayload<'community.owner-replacement'>;

/**
 * What raises the notification; the registry's `notify` unless a test supplies one. Its answer
 * says whether the notification now exists: stored, or already said (deduped). `notify` never
 * throws; a store failure answers with neither.
 */
export type RaiseOwnerNotice = (
  payload: Payload
) => Promise<{ notification: unknown; deduped: boolean }>;

/**
 * The ledger key, which is the registry's dedupe key too: one per request and phase.
 *
 * @param ref - The owner's connection ref.
 * @param notice - The notice.
 */
export function ownerNoticeKey(ref: string, notice: CommunityConnectionOwnerNotice): string {
  return `owner-replacement:${ref}:${notice.replacementId}:${notice.state}`;
}

/**
 * The notification payload for one notice.
 *
 * @param ref - The owner's connection ref.
 * @param communityLabel - What this DorkOS calls the community.
 * @param notice - The notice.
 */
export function ownerNoticePayload(
  ref: string,
  communityLabel: string,
  notice: CommunityConnectionOwnerNotice
): Payload {
  return notice.state === 'open'
    ? {
        ref,
        communityLabel,
        replacementId: notice.replacementId,
        phase: 'open',
        claimable: notice.requestState === 'claimable',
        claimableAfter: notice.claimableAfter,
      }
    : {
        ref,
        communityLabel,
        replacementId: notice.replacementId,
        phase: 'completed',
        newOwnerDisplayName: notice.newOwnerDisplayName,
      };
}

/** The ledger's keys; absent, unreadable or corrupt all mean nothing was announced yet. */
function parseLedger(text: string): Set<string> {
  try {
    const keys: unknown = JSON.parse(text);
    return new Set(
      Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : []
    );
  } catch {
    return new Set();
  }
}

/**
 * Announce each owner notice once, ever, per request and phase.
 *
 * Never throws: a ledger that cannot be read or written costs at most a repeated notification
 * (the registry's window still holds), never the connection list it is called from. A raise that
 * stored nothing is not recorded, so a passing store failure is retried on the next read.
 */
export class CommunityOwnerNoticeAnnouncer {
  private announced?: Promise<Set<string>>;
  /** Writes run one after another, so two reads never interleave a read-modify-write. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dorkHome: string,
    private readonly raise: RaiseOwnerNotice = (payload) =>
      notify('community.owner-replacement', payload)
  ) {}

  /**
   * Raise the notification for this notice unless it was announced before.
   *
   * @param ref - The owner's connection ref.
   * @param communityLabel - What this DorkOS calls the community.
   * @param notice - The notice the owner's connection carries now.
   */
  announce(
    ref: string,
    communityLabel: string,
    notice: CommunityConnectionOwnerNotice
  ): Promise<void> {
    const key = ownerNoticeKey(ref, notice);
    const step = this.queue.then(async () => {
      try {
        const announced = await this.load();
        if (announced.has(key)) return;
        // Raise first, and remember it only once it exists: a store that failed this time stores
        // nothing, and the next read must try again rather than find it marked as said.
        const result = await this.raise(ownerNoticePayload(ref, communityLabel, notice));
        if (!result.notification && !result.deduped) return;
        announced.add(key);
        await this.save(announced);
      } catch (err) {
        logger.debug('[Notifications] Could not announce an owner notice', { err });
      }
    });
    this.queue = step;
    return step;
  }

  /** Resolves once every announcement started so far has settled. */
  idle(): Promise<void> {
    return this.queue;
  }

  private file(): string {
    return path.join(this.dorkHome, OWNER_NOTICE_LEDGER_FILE);
  }

  private load(): Promise<Set<string>> {
    return (this.announced ??= readFile(this.file(), 'utf-8').then(parseLedger, () => new Set()));
  }

  private async save(announced: Set<string>): Promise<void> {
    const keys = [...announced].slice(-MAX_REMEMBERED);
    if (keys.length < announced.size) {
      announced.clear();
      for (const key of keys) announced.add(key);
    }
    await mkdir(path.dirname(this.file()), { recursive: true });
    await writeFileAtomic(this.file(), JSON.stringify(keys));
  }
}
