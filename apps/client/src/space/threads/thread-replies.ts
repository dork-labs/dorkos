import type { CommunityWireThreadSummary } from '@dorkos/shared/community-wire';
import type { Entry } from '../types.js';

/** What the line under a thread root says: how many replies, and when the newest landed. */
export type ThreadReplies = { count: number; lastAt: string };

/** The most roots one `GET /channels/:id/threads` read may name. */
export const THREAD_SUMMARY_BATCH = 100;

/**
 * Split the roots on screen into the batches the thread-summary route accepts.
 *
 * @param rootIds - Top-level message ids, in any order; duplicates are dropped.
 */
export function threadSummaryBatches(rootIds: readonly string[]): string[][] {
  const unique = [...new Set(rootIds)];
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += THREAD_SUMMARY_BATCH)
    batches.push(unique.slice(start, start + THREAD_SUMMARY_BATCH));
  return batches;
}

/**
 * Work out the reply line under each thread root on the page.
 *
 * The channel's history holds top-level messages only, so the count comes from the server
 * (`GET /channels/:id/threads`), together with the channel sequence of the newest reply it
 * counted (`lastReplySeq`). Replies the tab sees afterwards, on the live stream or because the
 * reader sent them, add one each, but only above that sequence: a reply the count already holds
 * is never counted twice, however it reached the tab. A root the server sent no count for (it had
 * no replies when read, or the server predates counts) is counted from the replies seen here.
 *
 * The same arithmetic as the DorkOS app's `remoteThreadReplies`, so both show the same number.
 *
 * @param counted - The server's latest summary for each root, by root id.
 * @param seen - Replies this tab has seen since, by reply id.
 * @returns One entry per root that has at least one reply.
 */
export function threadReplies(
  counted: ReadonlyMap<string, CommunityWireThreadSummary>,
  seen: ReadonlyMap<string, Entry>
): Map<string, ThreadReplies> {
  const added = new Map<string, { count: number; newest: Entry }>();
  for (const reply of seen.values()) {
    const rootId = reply.threadRootEntryId;
    if (!reply.parentEntryId || !rootId) continue;
    const through = counted.get(rootId)?.lastReplySeq;
    if (through !== undefined && reply.seq <= through) continue;
    const current = added.get(rootId);
    added.set(rootId, {
      count: (current?.count ?? 0) + 1,
      newest: current && current.newest.seq > reply.seq ? current.newest : reply,
    });
  }
  const lines = new Map<string, ThreadReplies>();
  for (const rootId of new Set([...counted.keys(), ...added.keys()])) {
    const base = counted.get(rootId);
    const extra = added.get(rootId);
    lines.set(rootId, {
      count: (base?.replyCount ?? 0) + (extra?.count ?? 0),
      lastAt: extra?.newest.createdAt ?? base!.lastReplyAt,
    });
  }
  return lines;
}

/**
 * The words on the reply line, "3 replies · last 9:45 AM", as the DorkOS app writes them. They
 * are also the line's accessible name.
 *
 * @param replies - The line's count and newest reply time.
 * @param time - That time, already formatted for the reader.
 */
export function threadRepliesLabel(replies: ThreadReplies, time: string): string {
  return `${replies.count} ${replies.count === 1 ? 'reply' : 'replies'} · last ${time}`;
}
