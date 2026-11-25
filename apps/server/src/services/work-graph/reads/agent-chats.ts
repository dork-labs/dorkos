/**
 * `agent_chats` (W4, DOR-4970): every chat this DorkOS bound to an agent's
 * folder, ended ones included, newest first, a page at a time. The live ones
 * are `running_chats`; this is the whole history this computer knows.
 *
 * A reader gets only the chats it may read (spec `audit-trail` §3.4): an
 * agent never gets a person's own chat, not its id, not its title, and not a
 * count of them. Chats it may not read are left out before the page is cut.
 * A page that fills gives a cursor only when a chat the reader may read
 * follows.
 *
 * **Bounded.** One page scans at most {@link AGENT_CHATS_SCAN_LIMIT} bindings,
 * so a reader whose agent has mostly private chats can't make one call read
 * them all. A page that stops at that bound with bindings left holds what it
 * found, which may be nothing, and still carries a cursor to go on. Such a
 * page tells a reader that more bindings exist beyond the scan, not how many,
 * whose or what they hold (Security accepted this, DOR-4970). The cursor is
 * sealed and bound to its reader (`./page-cursor.ts`): the binding it stops
 * at may be one the reader may not read.
 *
 * @module services/work-graph/reads/agent-chats
 */
import { dorkReferenceOrNull } from '@dorkos/shared/dork-ref';
import { chatRefMarkdownLink } from '@dorkos/shared/session-link';
import type { AgentChat, AgentChatsPage } from '@dorkos/shared/work-graph-reads';
import { readableSessionIds } from '../../audit/session-visibility.js';
import type { AuditReader } from '../../audit/visibility.js';
import { getSessionStartedByStore } from '../../session/origin/session-started-by-store.js';
import { decodePageCursor, encodePageCursor, pairOf } from './page-cursor.js';
import { agentBindingsPage, type BindingCursor, type ChatBinding } from './chat-bindings.js';
import type { Db } from '@dorkos/db';

/** How many bindings one scan step reads while it fills a page. */
const SCAN_STEP = 200;

/** The most bindings one page scans, readable or not. */
export const AGENT_CHATS_SCAN_LIMIT = 10 * SCAN_STEP;

/** What {@link readAgentChats} reads. */
export interface AgentChatsSources {
  /** The DorkOS database. */
  db: Db;
  /** A chat's title, or null. */
  titleOf: (chatId: string) => Promise<string | null>;
}

/** What {@link readAgentChats} is asked. */
export interface AgentChatsQuery {
  /** The agent's folder. */
  agentPath: string;
  /** The `nextCursor` of the page before, if any. */
  cursor?: string | undefined;
  /** How many chats this page holds at most. */
  limit: number;
}

/**
 * One page of an agent's chats as `reader` may see them.
 *
 * @param query - The agent's folder, the cursor and the page size.
 * @param reader - Who is asking.
 * @param sources - Where the facts come from.
 */
export async function readAgentChats(
  query: AgentChatsQuery,
  reader: AuditReader,
  sources: AgentChatsSources
): Promise<AgentChatsPage> {
  // One more than the page, so a cursor is given only when a readable chat follows.
  const wanted = query.limit + 1;
  const kept: ChatBinding[] = [];
  let after: BindingCursor | null = null;
  if (query.cursor !== undefined) {
    const [createdAt, chatId] = pairOf(decodePageCursor(reader, query.cursor));
    after = { createdAt, chatId };
  }
  // Where a page that stops at the scan bound goes on from: the last binding it scanned.
  let stoppedAt: BindingCursor | null = null;
  for (let scannedSoFar = 0; ;) {
    const step = Math.min(SCAN_STEP, AGENT_CHATS_SCAN_LIMIT - scannedSoFar);
    const scanned = agentBindingsPage(sources.db, query.agentPath, after, step);
    scannedSoFar += scanned.length;
    const readable = readableSessionIds(
      reader,
      scanned.map((binding) => binding.chatId)
    );
    for (const binding of scanned) {
      if (readable.has(binding.chatId)) kept.push(binding);
      if (kept.length === wanted) break;
    }
    if (kept.length === wanted || scanned.length < step) break;
    after = scanned.at(-1)!;
    if (scannedSoFar >= AGENT_CHATS_SCAN_LIMIT) {
      stoppedAt = after;
      break;
    }
  }
  const page = kept.slice(0, query.limit);
  const last = page.at(-1);
  const goOnFrom = kept.length > page.length ? last : stoppedAt;
  return {
    chats: await describeChats(page, reader, sources),
    nextCursor: goOnFrom ? encodePageCursor(reader, [goOnFrom.createdAt, goOnFrom.chatId]) : null,
  };
}

/** Each listed chat with its title and the chat that started it, when the reader may see that one. */
async function describeChats(
  page: readonly ChatBinding[],
  reader: AuditReader,
  sources: AgentChatsSources
): Promise<AgentChat[]> {
  const records = getSessionStartedByStore()?.getMany(page.map((b) => b.chatId)) ?? new Map();
  const starterOf = new Map<string, string>();
  for (const binding of page) {
    const record = records.get(binding.chatId);
    if (record?.kind === 'chat' && record.startedBySessionId !== null) {
      starterOf.set(binding.chatId, record.startedBySessionId);
    }
  }
  const readableStarters = readableSessionIds(reader, [...new Set(starterOf.values())]);
  return Promise.all(
    page.map(async (binding): Promise<AgentChat> => {
      const title = await sources.titleOf(binding.chatId);
      const starter = starterOf.get(binding.chatId) ?? null;
      return {
        id: binding.chatId,
        ref: dorkReferenceOrNull('chat', binding.chatId),
        link: chatRefMarkdownLink(binding.chatId, title),
        title,
        createdAt: binding.createdAt,
        runtime: binding.runtime,
        spinOff: starter !== null,
        startedBy:
          starter !== null && readableStarters.has(starter)
            ? { id: starter, title: await sources.titleOf(starter) }
            : null,
      };
    })
  );
}
