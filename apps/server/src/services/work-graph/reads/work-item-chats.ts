/**
 * Who worked on a ticket or pull request, and when (DOR-4972): the chats that
 * claimed it, as spans read off the work graph's `claims` and `released`
 * edges. `work_claims` is the lock and holds only live claims; these edges are
 * the history.
 *
 * **How the edges pair into spans.** Per chat (by the id it has now: edges
 * under an older id count as its own, through `rekeyed_from`) and in the
 * order the transitions happened:
 *
 * 1. A `claims` opens a span, when the claim tool, `session_start` (the new
 *    chat's own claim; its recording chat is the caller) or a hand-over (the
 *    taker's) wrote it.
 * 2. The next `released` closes it; what wrote that row says how it ended
 *    (the release tool: released; the lapse sweep: lapsed; a hand-over:
 *    handed over).
 * 3. A second `claims` before any `released` closes the earlier span at the
 *    later one's start, ended by `unknown`.
 * 4. A `released` with no open span is ignored.
 * 5. A `claims` with no later `released` is a span still open.
 *
 * One chat's rows are taken in order of `recorded_at`, then of their id.
 *
 * A span the session-end cleanup closed is left out: its chat never started
 * (`releaseSession` is called for a start that was cancelled before launch),
 * as the lineage query leaves out a chat that never started.
 *
 * **What a reader may not read (Security, DOR-4972; W4's rule).** A span of a
 * chat the reader may not read keeps only its relation and the day it began
 * and ended: no chat, no time finer than the day, no end reason. Two such
 * spans on the same days read as one, with no count, so they need no order
 * between them; private spans are never ordered by a time. A span the reader
 * may read that was handed over to a chat it may not read ends on the day
 * only (`endedAt` null, `endDay` set), as handed over and to no one named;
 * one taken over from such a chat starts on the day only (`claimedAt` null,
 * `startDay` set) and names no giver. So nothing on it times or names the
 * other chat. A hand-over between two chats it may read stays exact.
 *
 * @module services/work-graph/reads/work-item-chats
 */
import type { EntityRef } from '@dorkos/shared/entity-ref';
import type {
  ClaimSpanEnd,
  WorkItemChatsPage,
  WorkItemSpan,
  WorkKind,
} from '@dorkos/shared/work-graph-reads';
import type { AuditReader } from '../../audit/visibility.js';
import type { WorkLink, WorkLinkStore } from '../work-link-store.js';
import { decodePageCursor, encodePageCursor, invalidCursor } from './page-cursor.js';

/** What {@link readWorkItemChats} reads. */
export type WorkItemChatsSources = Pick<WorkLinkStore, 'to' | 'resolveRekeys'>;

/** What {@link readWorkItemChats} is asked. */
export interface WorkItemChatsQuery {
  /** The ticket or pull request. */
  ref: EntityRef<WorkKind>;
  /** The `nextCursor` of the page before, if any. */
  cursor?: string | undefined;
  /** Who is asking: a cursor is bound to the reader it was given to. */
  reader: AuditReader;
  /** How many spans this page holds at most. */
  limit: number;
}

/** A span with the chat it belongs to, before the reader's view is cut. */
export interface ChatSpan {
  /** The chat, by its current id. */
  chatId: string;
  /** When it began (ISO 8601). */
  claimedAt: string;
  /** When it ended, or null while open. */
  endedAt: string | null;
  /** How it ended, or null while open. */
  endedBy: ClaimSpanEnd | null;
  /** For a hand-over, the chat that took it, by its current id; otherwise null. Never shown. */
  handedTo: string | null;
  /** Whether the span began with a hand-over to this chat. */
  takenOver: boolean;
  /** For a hand-over to this chat, the chat that gave it, when its row was found. Never shown. */
  handedFrom: string | null;
}

/** The writers whose `claims` row opens a span. */
const STARTED_BY_WRITER: ReadonlySet<string> = new Set([
  'claim-tool',
  'session-start',
  'hand-over',
]);

/** How each writer of a `released` row reads as a span's end; absent ones are left out. */
const END_BY_WRITER: Readonly<Record<string, ClaimSpanEnd>> = {
  'release-tool': 'released',
  'lapse-sweep': 'lapsed',
  'hand-over': 'handed-over',
};

/** The writer whose `released` row means the chat never started. */
const NEVER_STARTED = 'session-end';

/**
 * Pair a ticket's `claims` and `released` edges into spans, by the rule in
 * this module's header.
 *
 * @param links - The item's `claims` and `released` edges, any order.
 * @param currentOf - Each chat id an edge names (its subject, and a hand-over's
 *   recording chat), mapped to the id it has now.
 * @returns The spans, the left-out ones already dropped.
 */
export function pairClaimSpans(
  links: readonly WorkLink[],
  currentOf: ReadonlyMap<string, string>
): ChatSpan[] {
  const current = (id: string) => currentOf.get(id) ?? id;
  // A hand-over writes the giver's `released` and the taker's `claims` at one time, both
  // naming the taker as the recording chat: the giver is found from the taker and the time.
  const giverOf = new Map<string, string>();
  for (const link of links) {
    if (link.relation === 'released' && link.source === 'hand-over' && link.recordingChatId)
      giverOf.set(`${current(link.recordingChatId)}\n${link.recordedAt}`, current(link.from.id));
  }
  const byChat = new Map<string, WorkLink[]>();
  for (const link of links) {
    const chatId = currentOf.get(link.from.id) ?? link.from.id;
    byChat.set(chatId, [...(byChat.get(chatId) ?? []), link]);
  }
  const spans: ChatSpan[] = [];
  for (const [chatId, own] of byChat) {
    const ordered = [...own].sort(
      (a, b) => compare(a.recordedAt, b.recordedAt) || compare(a.id, b.id)
    );
    let open: Pick<ChatSpan, 'claimedAt' | 'takenOver' | 'handedFrom'> | null = null;
    for (const link of ordered) {
      if (link.relation === 'claims') {
        if (!STARTED_BY_WRITER.has(link.source)) continue;
        if (open !== null)
          spans.push({
            chatId,
            ...open,
            endedAt: link.recordedAt,
            endedBy: 'unknown',
            handedTo: null,
          });
        const takenOver = link.source === 'hand-over';
        open = {
          claimedAt: link.recordedAt,
          takenOver,
          handedFrom: takenOver ? (giverOf.get(`${chatId}\n${link.recordedAt}`) ?? null) : null,
        };
        continue;
      }
      if (open === null) continue;
      if (link.source !== NEVER_STARTED) {
        spans.push({
          chatId,
          ...open,
          endedAt: link.recordedAt,
          endedBy: END_BY_WRITER[link.source] ?? 'unknown',
          handedTo:
            link.source === 'hand-over' && link.recordingChatId !== null
              ? current(link.recordingChatId)
              : null,
        });
      }
      open = null;
    }
    if (open !== null)
      spans.push({ chatId, ...open, endedAt: null, endedBy: null, handedTo: null });
  }
  return spans;
}

/** A span as a reader sees it, with the key it sorts by. */
interface Shown {
  span: WorkItemSpan;
  key: SortKey;
}

/**
 * Day it began; within a day, the readable spans with an exact start by that time then
 * chat, then the readable ones whose start is the day only, by chat, then the private ones
 * by the day they ended (open last). No key holds a time the reader may not see.
 */
type SortKey = [day: string, group: '0' | '1' | '2', a: string, b: string];

/**
 * One page of the chats that claimed `ref`, as the reader may see them.
 *
 * @param query - The item, the page and the reader.
 * @param readable - Decides which of the chats the reader may read.
 * @param sources - The edge store.
 */
export function readWorkItemChats(
  query: WorkItemChatsQuery,
  readable: (chatIds: readonly string[]) => ReadonlySet<string>,
  sources: WorkItemChatsSources
): WorkItemChatsPage {
  const links = [...sources.to(query.ref, 'claims'), ...sources.to(query.ref, 'released')];
  const named = links.flatMap((link) =>
    link.recordingChatId === null ? [link.from.id] : [link.from.id, link.recordingChatId]
  );
  const currentOf = sources.resolveRekeys([...new Set(named)]);
  const spans = pairClaimSpans(links, currentOf);
  const mayRead = readable([
    ...new Set(
      spans.flatMap((span) =>
        [span.chatId, span.handedTo, span.handedFrom].filter((id): id is string => id !== null)
      )
    ),
  ]);

  const shown: Shown[] = [];
  const privateSeen = new Set<string>();
  for (const span of spans) {
    const day = span.claimedAt.slice(0, 10);
    const endDay = span.endedAt?.slice(0, 10) ?? null;
    if (mayRead.has(span.chatId)) {
      // Handed to, or taken from, a chat this reader may not read (or one whose row is
      // missing): that end or start is the day only, and no one is named.
      const endHidden = span.handedTo !== null && !mayRead.has(span.handedTo);
      const startHidden =
        span.takenOver && (span.handedFrom === null || !mayRead.has(span.handedFrom));
      shown.push({
        span: {
          relation: 'claims',
          chatId: span.chatId,
          claimedAt: startHidden ? null : span.claimedAt,
          startDay: day,
          endedAt: endHidden ? null : span.endedAt,
          endDay,
          endedBy: span.endedBy,
        },
        key: startHidden ? [day, '1', '', span.chatId] : [day, '0', span.claimedAt, span.chatId],
      });
      continue;
    }
    const seen = `${day}\n${endDay ?? ''}`;
    if (privateSeen.has(seen)) continue;
    privateSeen.add(seen);
    // A null end sorts after every day.
    shown.push({
      span: { relation: 'claims', startDay: day, endDay },
      key: [day, '2', endDay ?? '~', ''],
    });
  }
  shown.sort((a, b) => compareKeys(a.key, b.key));

  const after =
    query.cursor === undefined ? null : keyOf(decodePageCursor(query.reader, query.cursor));
  const rest = after ? shown.filter((entry) => compareKeys(entry.key, after) > 0) : shown;
  const page = rest.slice(0, query.limit);
  const last = page.at(-1);
  return {
    ref: { kind: query.ref.kind, id: query.ref.id },
    spans: page.map((entry) => entry.span),
    nextCursor: rest.length > page.length && last ? encodePageCursor(query.reader, last.key) : null,
  };
}

function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.length; i += 1) {
    const order = compare(a[i]!, b[i]!);
    if (order !== 0) return order;
  }
  return 0;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The sort key a cursor holds, or the refusal. */
function keyOf(position: unknown): SortKey {
  if (
    Array.isArray(position) &&
    position.length === 4 &&
    position.every((part) => typeof part === 'string') &&
    (position[1] === '0' || position[1] === '1' || position[1] === '2')
  ) {
    return position as SortKey;
  }
  throw invalidCursor();
}
