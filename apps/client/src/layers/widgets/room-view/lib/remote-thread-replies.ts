/**
 * The "3 replies" line under a thread root in a Community channel.
 *
 * @module widgets/room-view/lib/remote-thread-replies
 */
import type { RemoteCommunityEntry } from '@dorkos/shared/community-views';
import type { ThreadReplySummary } from '@/layers/entities/room';

/**
 * Work out what the reply line under each thread root in a Community channel
 * says.
 *
 * A channel's history is top-level only, so the replies themselves are mostly
 * NOT here: the count comes from the Community server, on each root it sent
 * (`thread`), together with the sequence of the newest reply that count
 * included (`threadLastReplySeq`). Replies that stream in afterwards are the
 * ones above that sequence, so they are added to it one each — and a reply the
 * count already included is never counted twice, however it reached this
 * client. Without that line in the sand a live reply would either be missed
 * (count stays at 3) or counted twice after the next history read (3 + 1 = 5).
 *
 * A root the server sent no count for — none of its replies had been written
 * when it was read, or the server predates counts — is counted from the replies
 * that are here, which is all this client can honestly say.
 *
 * Unread is always zero: a Community read position is an opaque cursor, so this
 * client cannot tell which replies are above it and does not guess.
 *
 * @param roots - Top-level entries as history returned them, carrying the
 *   server's counts. Oldest page first, so a later read of a root wins.
 * @param loaded - Everything this view holds, history and live, replies
 *   included.
 * @returns One summary per root that has at least one reply.
 */
export function remoteThreadReplies(
  roots: readonly RemoteCommunityEntry[],
  loaded: readonly RemoteCommunityEntry[]
): Map<string, ThreadReplySummary> {
  const counted = new Map<string, { count: number; lastAt: string; through?: number }>();
  for (const root of roots) {
    if (!root.thread) continue;
    counted.set(root.id, {
      count: root.thread.replyCount,
      lastAt: root.thread.lastReplyAt,
      through: root.threadLastReplySeq,
    });
  }

  const added = new Map<string, { count: number; newest: RemoteCommunityEntry }>();
  for (const entry of loaded) {
    const rootId = entry.threadRootEntryId;
    if (entry.depth === 0 || rootId === null) continue;
    const through = counted.get(rootId)?.through;
    if (through !== undefined && entry.remoteSeq <= through) continue;
    const current = added.get(rootId);
    added.set(rootId, {
      count: (current?.count ?? 0) + 1,
      newest: current && current.newest.remoteSeq > entry.remoteSeq ? current.newest : entry,
    });
  }

  const summaries = new Map<string, ThreadReplySummary>();
  for (const rootId of new Set([...counted.keys(), ...added.keys()])) {
    const base = counted.get(rootId);
    const extra = added.get(rootId);
    // A count with no sequence cannot say which loaded replies it already
    // holds, so it is never added to — only overtaken, the way a local room's
    // snapshot count is (`threadReplySummary`).
    const count =
      base === undefined
        ? extra!.count
        : base.through === undefined
          ? Math.max(base.count, extra?.count ?? 0)
          : base.count + (extra?.count ?? 0);
    summaries.set(rootId, {
      count,
      lastAt: extra?.newest.createdAt ?? base!.lastAt,
      unread: 0,
    });
  }
  return summaries;
}
