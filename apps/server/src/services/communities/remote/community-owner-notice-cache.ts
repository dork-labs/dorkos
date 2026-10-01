/**
 * What each Community last told its owner about a request to replace them, held in memory so the
 * owner's connection list can show it without one slow Community holding up the list (DOR-2543).
 *
 * @module services/communities/remote/community-owner-notice-cache
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import {
  CommunityConnectionOwnerNoticeSchema,
  type CommunityConnectionOwnerNotice,
} from '@dorkos/shared/community-connections';
import type { CommunityWireOwnerReplacementNoticeResponse } from '@dorkos/shared/community-wire';
import {
  COMMUNITY_ATTENTION_BUDGET_MS,
  isCommunityReadRefusal,
} from './community-attention-cache.js';

/**
 * How old an answer may be and still be shown when this read's own request did not answer in
 * time: a little over two of the app's 30-second list polls. A Community that always answers
 * just past the budget still shows its notice, because each answer lands between polls; one
 * that stops answering stops showing it within a minute, instead of showing an old one.
 */
export const COMMUNITY_OWNER_NOTICE_FRESH_MS = 65_000;

interface Confirmed {
  /** What the owner is told, or nothing when there is nothing for the owner. */
  notice: CommunityConnectionOwnerNotice | undefined;
  /** When the Community's answer arrived. */
  at: number;
}

interface Entry {
  confirmed?: Confirmed;
  pending?: Promise<Confirmed>;
}

/**
 * Turn one Community answer into what its owner is told.
 *
 * Only the owner's view of an open request becomes a notice: an admin's view becomes nothing.
 * A completion becomes a notice only when the Community says it was this reader's (`wasYours`,
 * the owner it replaced); every other member's view of it becomes nothing. So a non-owner's
 * connection never carries one.
 */
function project(
  answer: CommunityWireOwnerReplacementNoticeResponse
): CommunityConnectionOwnerNotice | undefined {
  const { open, completed } = answer;
  if (open?.role === 'owner')
    return CommunityConnectionOwnerNoticeSchema.parse({
      state: 'open',
      replacementId: open.replacementId,
      requestState: open.state,
      requestedAt: open.requestedAt,
      claimableAfter: open.claimableAfter,
      claimReissuedAt: open.claimReissuedAt,
      options: open.options,
    });
  if (completed?.wasYours)
    return CommunityConnectionOwnerNoticeSchema.parse({
      state: 'completed',
      replacementId: completed.replacementId,
      newOwnerDisplayName: completed.newOwnerDisplayName,
      completedAt: completed.completedAt,
    });
  return undefined;
}

/**
 * Answer each Community's owner notice within the same budget as its attention counts.
 *
 * Both reads start together for each connection, so the notice adds nothing to how long the list
 * takes. A Community that answers in time gives this read's notice. One that is slow or fails
 * gives nothing, unless an answer landed within {@link COMMUNITY_OWNER_NOTICE_FRESH_MS}: never an
 * older one, because an owner who kept ownership in the browser must not keep being told. As with
 * the counts, a slow request keeps running (one per Community at a time) and its answer serves
 * the next read.
 *
 * A refusal (401/403, or a rejected grant) forgets that connection's answer at once. Entries are
 * owner-scoped, live only in memory, and are dropped by the same calls that drop a connection's
 * counts. Nothing here is needed to recognise a completion: the Community says whose it was.
 */
export class CommunityOwnerNoticeCache {
  private readonly owners = new Map<string, Map<CommunityRef, Entry>>();

  constructor(
    private readonly budgetMs = COMMUNITY_ATTENTION_BUDGET_MS,
    private readonly freshMs = COMMUNITY_OWNER_NOTICE_FRESH_MS,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Read one Community's owner notice within the budget.
   *
   * @param owner - The trusted local owner the connection belongs to.
   * @param ref - The owner's connection ref.
   * @param fetchNotice - Asks the Community what it tells this connection's member.
   * @returns The notice for the owner, or `undefined` when there is none to show.
   */
  async read(
    owner: string,
    ref: CommunityRef,
    fetchNotice: () => Promise<CommunityWireOwnerReplacementNoticeResponse>
  ): Promise<CommunityConnectionOwnerNotice | undefined> {
    const entry = this.entry(owner, ref);
    const pending = entry.pending ?? this.start(owner, ref, entry, fetchNotice);
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
    if (answered) return answered.notice;
    // Read again: a refusal while this read waited has already dropped the entry.
    const confirmed = this.owners.get(owner)?.get(ref)?.confirmed;
    return confirmed && this.now() - confirmed.at <= this.freshMs ? confirmed.notice : undefined;
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
   * Keep only this owner's still-readable connections; drop everything else, including every
   * other owner's notices.
   *
   * @param owner - The owner who is reading now.
   * @param readable - This owner's connections that may still show a notice.
   */
  retainOnly(owner: string, readable: Iterable<CommunityRef>): void {
    this.retainOwner(owner);
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
    owner: string,
    ref: CommunityRef,
    entry: Entry,
    fetchNotice: () => Promise<CommunityWireOwnerReplacementNoticeResponse>
  ): Promise<Confirmed> {
    // A forget() or retainOnly() while the request is out detaches `entry` from the map, so a
    // late answer lands on an object nothing reads again.
    const pending = Promise.resolve()
      .then(fetchNotice)
      .then((answer) => {
        const confirmed = { notice: project(answer), at: this.now() };
        entry.confirmed = confirmed;
        return confirmed;
      })
      .catch((error: unknown) => {
        if (isCommunityReadRefusal(error) && this.owners.get(owner)?.get(ref) === entry)
          this.forget(owner, ref);
        throw error;
      })
      .finally(() => {
        if (entry.pending === pending) entry.pending = undefined;
      });
    // The request may outlive every reader; its failure already means "no notice".
    pending.catch(() => undefined);
    entry.pending = pending;
    return pending;
  }
}
