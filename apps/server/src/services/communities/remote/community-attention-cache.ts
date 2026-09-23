/**
 * The last unread and mention counts each Community confirmed, held in memory
 * so one slow Community cannot hold up the owner's whole connection list.
 *
 * @module services/communities/remote/community-attention-cache
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { CommunityConnectionAttention } from '@dorkos/shared/community-connections';

/**
 * How long one list read waits for a Community's counts before it answers with
 * the last counts that Community confirmed. Every Community is asked in
 * parallel, so this bounds the attention part of the whole list, not each row.
 */
export const COMMUNITY_ATTENTION_BUDGET_MS = 750;

/** Counts exactly as a Community reported them. Untrusted until checked. */
export interface CommunityAttentionCounts {
  unreadCount: number;
  mentionCount: number;
}

interface ConfirmedCounts extends CommunityAttentionCounts {
  verifiedAt: string;
}

interface Entry {
  confirmed?: ConfirmedCounts;
  pending?: Promise<ConfirmedCounts>;
}

const UNAVAILABLE: CommunityConnectionAttention = {
  state: 'unavailable',
  unreadCount: null,
  mentionCount: null,
  verifiedAt: null,
};

/** Refuse counts that cannot be real, so a lying Community never becomes the fallback. */
function checkCounts(counts: CommunityAttentionCounts): CommunityAttentionCounts {
  const { unreadCount, mentionCount } = counts;
  if (
    !Number.isSafeInteger(unreadCount) ||
    !Number.isSafeInteger(mentionCount) ||
    unreadCount < 0 ||
    mentionCount < 0 ||
    mentionCount > unreadCount
  ) {
    throw new Error('Community reported impossible attention counts');
  }
  return { unreadCount, mentionCount };
}

/**
 * Answer each Community's attention within a fixed budget.
 *
 * A Community that answers in time is `verified`. One that is slow, fails, or
 * reports impossible counts falls back to the last counts it confirmed, marked
 * `stale` with the time they were confirmed, or to `unavailable` when it never
 * confirmed any. A slow request is not abandoned: it keeps running, and when it
 * lands it becomes the fallback the next read (the client's poll) picks up.
 * Only one request per Community is ever in flight, so a Community that stays
 * slow is not asked again by every poll that times out on it.
 *
 * Entries are owner-scoped and live only in memory, never beside credentials.
 * They hold nothing but two counts and a time. Callers drop an entry the moment
 * a connection stops being readable (disconnect, revocation, lost read access)
 * and drop every other owner's entries whenever an owner reads, so neither a
 * removed Community nor a previous owner's counts can resurface.
 *
 * It deliberately never announces a background result on the live stream: the
 * announcement makes every window re-read the list, and that read would start
 * the next background request, which would announce again.
 */
export class CommunityAttentionCache {
  private readonly owners = new Map<string, Map<CommunityRef, Entry>>();

  constructor(
    private readonly budgetMs = COMMUNITY_ATTENTION_BUDGET_MS,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Read one Community's attention within the budget.
   *
   * @param owner - The trusted local owner the connection belongs to.
   * @param ref - The owner's connection ref.
   * @param fetchCounts - Asks the Community for its current counts.
   */
  async read(
    owner: string,
    ref: CommunityRef,
    fetchCounts: () => Promise<CommunityAttentionCounts>
  ): Promise<CommunityConnectionAttention> {
    const entry = this.entry(owner, ref);
    const pending = entry.pending ?? this.start(entry, fetchCounts);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = await Promise.race([
      pending.then(
        (confirmed) => confirmed,
        () => null
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.budgetMs);
      }),
    ]);
    clearTimeout(timer);
    if (answered) return { state: 'verified', ...answered };
    return this.lastConfirmed(owner, ref);
  }

  /**
   * The last counts this Community confirmed, as `stale`, without asking it
   * again; `unavailable` when it never confirmed any. For a Community that is
   * offline right now but was readable before the outage.
   *
   * @param owner - The trusted local owner the connection belongs to.
   * @param ref - The owner's connection ref.
   */
  lastConfirmed(owner: string, ref: CommunityRef): CommunityConnectionAttention {
    const confirmed = this.owners.get(owner)?.get(ref)?.confirmed;
    return confirmed ? { state: 'stale', ...confirmed } : UNAVAILABLE;
  }

  /**
   * Forget one connection, including any request still in flight for it.
   *
   * @param owner - The local owner the connection belonged to.
   * @param ref - The connection ref.
   */
  forget(owner: string, ref: CommunityRef): void {
    const refs = this.owners.get(owner);
    refs?.delete(ref);
    if (refs?.size === 0) this.owners.delete(owner);
  }

  /**
   * Keep only this owner's still-readable connections; drop everything else,
   * including every other owner's counts.
   *
   * @param owner - The owner who is reading now.
   * @param readable - This owner's connections that may still show counts.
   */
  retainOnly(owner: string, readable: Iterable<CommunityRef>): void {
    for (const key of this.owners.keys()) if (key !== owner) this.owners.delete(key);
    const refs = this.owners.get(owner);
    if (!refs) return;
    const keep = new Set(readable);
    for (const ref of refs.keys()) if (!keep.has(ref)) refs.delete(ref);
    if (refs.size === 0) this.owners.delete(owner);
  }

  /**
   * Drop every owner except this one, without touching this owner's entries.
   *
   * @param owner - The owner who is reading now.
   */
  retainOwner(owner: string): void {
    for (const key of this.owners.keys()) if (key !== owner) this.owners.delete(key);
  }

  private entry(owner: string, ref: CommunityRef): Entry {
    let refs = this.owners.get(owner);
    if (!refs) this.owners.set(owner, (refs = new Map()));
    let entry = refs.get(ref);
    if (!entry) refs.set(ref, (entry = {}));
    return entry;
  }

  private start(
    entry: Entry,
    fetchCounts: () => Promise<CommunityAttentionCounts>
  ): Promise<ConfirmedCounts> {
    // A forget() or retainOnly() while the request is out detaches `entry`
    // from the map, so a late answer lands on an object nothing reads again.
    const pending = Promise.resolve()
      .then(fetchCounts)
      .then((counts) => {
        const confirmed = { ...checkCounts(counts), verifiedAt: this.now().toISOString() };
        entry.confirmed = confirmed;
        return confirmed;
      })
      .finally(() => {
        if (entry.pending === pending) entry.pending = undefined;
      });
    // The request may outlive every reader; its failure is already the fallback.
    pending.catch(() => undefined);
    entry.pending = pending;
    return pending;
  }
}
