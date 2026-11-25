/**
 * The work reads (W4, DOR-4970): every pull request and ticket a set of chats
 * is linked to in the work graph, one item per thing, with each link that
 * names it. The set is an agent's chats, or one chat and the chats below it
 * (the lineage query's subtree, W3).
 *
 * Every relation in the store's own set is read (`WORK_LINK_RELATIONS`), and
 * each link comes back with its relation as stored, so a new relation is
 * listed on purpose, in the store, and never by a string here. Only links to a
 * pull request or a ticket are kept.
 *
 * Links recorded under a chat's older id (before a re-key, ADR-0267) count as
 * the chat's own.
 *
 * **What a reader may not read (Security, DOR-4970; the audit scrub rule,
 * `audit/audit-session-scrub.ts`).** What was done is the space's to read;
 * where it was done is private. So an item linked only from chats the reader
 * may not read is still listed, but each such link carries only its relation
 * and the day it was recorded: no chat, no time finer than the day, no
 * source label and no turn marks, and two such links of one relation on one
 * day read as one, so nothing on the item counts or points back at the chat.
 * Nothing on an item is copied from a chat's words: an item is its reference.
 *
 * @module services/work-graph/reads/work-for
 */
import { formatEntityRef, type EntityRef } from '@dorkos/shared/entity-ref';
import type { WorkItem, WorkItemLink, WorkKind, WorkPage } from '@dorkos/shared/work-graph-reads';
import type { LineageReads } from '../lineage-reads.js';
import { decodePageCursor, encodePageCursor } from './page-cursor.js';
import { WORK_LINK_RELATIONS, type WorkLink, type WorkLinkStore } from '../work-link-store.js';

/** The kinds of work listed when none is asked for. */
const ALL_WORK_KINDS: readonly WorkKind[] = ['pr', 'ticket'];

/** What {@link readWork} reads. */
export interface WorkSources {
  /** The work graph's edges. */
  links: Pick<WorkLinkStore, 'fromMany'>;
  /** The lineage reads, for each chat's older ids. */
  aliases: Pick<LineageReads, 'aliases'>;
}

/** What {@link readWork} is asked. */
export interface WorkQuery {
  /** The chats whose work to list, by current id. */
  chatIds: readonly string[];
  /** Only this kind, or both. */
  kind?: WorkKind | undefined;
  /** The `nextCursor` of the page before, if any. */
  cursor?: string | undefined;
  /** How many items this page holds at most. */
  limit: number;
}

/** An item before it is cut into a page. */
interface Gathered {
  ref: EntityRef<WorkKind>;
  text: string;
  firstRecordedOn: string;
  links: WorkItemLink[];
}

/**
 * One page of the work these chats are linked to, as a reader may see it.
 *
 * Items list newest first by the day they were first linked, then by how
 * they are written. The cursor is that key of the page's last item.
 *
 * @param query - The chats, the kind and the page.
 * @param readable - The chats among them the reader may read.
 * @param sources - Where the links come from.
 */
export function readWork(
  query: WorkQuery,
  readable: ReadonlySet<string>,
  sources: WorkSources
): WorkPage {
  const kinds = new Set<string>(query.kind ? [query.kind] : ALL_WORK_KINDS);
  const { of, owner } = sources.aliases.aliases(query.chatIds);
  const refs = [...of.values()].flat().map((id) => ({ kind: 'chat' as const, id }));
  const found: WorkLink[] = WORK_LINK_RELATIONS.flatMap((relation) =>
    sources.links.fromMany(refs, relation)
  ).filter((link) => kinds.has(link.to.kind));
  found.sort((a, b) => compare(a.recordedAt, b.recordedAt) || compare(a.id, b.id));

  const items = new Map<string, Gathered>();
  const privateSeen = new Set<string>();
  for (const link of found) {
    const ref = link.to as EntityRef<WorkKind>;
    const text = formatEntityRef(ref);
    const day = link.recordedAt.slice(0, 10);
    const item = items.get(text) ?? {
      ref: { kind: ref.kind, id: ref.id },
      text,
      firstRecordedOn: day,
      links: [],
    };
    items.set(text, item);
    const chatId = owner.get(link.from.id) ?? link.from.id;
    if (readable.has(chatId)) {
      item.links.push({ relation: link.relation, chatId, recordedAt: link.recordedAt });
      continue;
    }
    const key = `${text}\n${link.relation}\n${day}`;
    if (privateSeen.has(key)) continue;
    privateSeen.add(key);
    item.links.push({ relation: link.relation, chatId: null, recordedOn: day });
  }

  const ordered = [...items.values()].sort(newestFirst);
  const after = query.cursor === undefined ? null : keyOf(decodePageCursor(query.cursor));
  const rest = after ? ordered.filter((item) => newestFirst(item, after) > 0) : ordered;
  const page = rest.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((item): WorkItem => ({ ...item })),
    nextCursor:
      rest.length > page.length && last
        ? encodePageCursor([last.firstRecordedOn, last.text])
        : null,
  };
}

/** The sort key a cursor holds. */
type WorkKey = Pick<Gathered, 'firstRecordedOn' | 'text'>;

/** Newest day first, then by how the item is written. */
function newestFirst(a: WorkKey, b: WorkKey): number {
  return compare(b.firstRecordedOn, a.firstRecordedOn) || compare(a.text, b.text);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The key a cursor's two strings name. */
function keyOf([firstRecordedOn, text]: [string, string]): WorkKey {
  return { firstRecordedOn, text };
}
