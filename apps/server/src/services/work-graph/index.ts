/**
 * The work graph (DOR-4966; ADR 261124-131941): what a chat started, claims,
 * opened, works on and produced, as append-only edges between entity
 * references. This barrel installs the edge store and owns its write sites.
 *
 * Every write site here follows one rule: recording the edge never decides the
 * action. A write that fails is logged and dropped, and the re-key, the fork or
 * the start it describes goes on, because a chat must not fail for want of its own record.
 *
 * Write sites today:
 *
 * - **A re-key** (ADR-0267): when a chat's id gives way to its runtime's, the
 *   new id is recorded `rekeyed_from` the old one, as an optional participant of
 *   the durable identity move (`session/turn-identity/durable-rekey.ts`) that
 *   every caller of `createCanonicalRekey` reaches through `rekeyProjector`. It
 *   runs only once the required identity carry succeeded, so a refused move
 *   records nothing.
 * - **A fork**: the fork's id is recorded `forked_from` its source chat
 *   ({@link recordChatFork}, called by `POST /api/sessions/:id/fork`).
 * - **A start** (DOR-5263): a chat that another chat started (the
 *   `session_start` tool, a spin-off) is recorded as the starting chat
 *   `started` the new one, in the same step as its `session_started_by` row,
 *   through `onSessionStartRecorded`
 *   (`session/origin/session-started-by-store.ts`). A start no chat made (an
 *   extension's own, or the work queue's) records nothing: it has no starting
 *   chat to name. A carry-over to another account records nothing either: it
 *   is a move, not a new start, and the lineage query follows carries from
 *   `session_started_by` itself. A second record of the same start is not
 *   announced, so it records nothing new. The link stays even when the start
 *   is cancelled before its chat launches, so read starts through the lineage
 *   query (W3, DOR-4969), not this table alone.
 *
 * Two read sites:
 *
 * - **A re-key**: the re-key edges are registered as the durable record
 *   `followChatRekey` asks once the in-memory redirect is gone
 *   (`session/turn-identity/follow-chat-rekey.ts`), so a `/r/` link holding a
 *   new chat's first id still opens it after a restart.
 * - **A lineage** (W3, DOR-4969): {@link readChatLineage} answers a chat's
 *   ancestors and subtree from the `started` links and `session_started_by`,
 *   and is the one place that decides which started chats a reader is shown
 *   (`./chat-lineage.ts`).
 *
 * The read tools (W4, DOR-4970: an agent's chats, a chat's tree and the work
 * linked to either) are in `./reads/`, and read chat bindings only through
 * `./reads/chat-bindings.ts`.
 *
 * The store lives in this computer's SQLite store for now; its move to the
 * space store is DOR-5139 (ADR 261122-173853). The store is space data; turn
 * code reaches it only through hooks or events, so DOR-5139 is a store move,
 * not a rewrite. Nothing under `services/runtimes/` or `services/session/`
 * imports this domain (the `work-graph/stay-out` lint rule): the re-key
 * write and read and the start write register themselves on the session's
 * hooks, and the fork
 * write is called by the route, since a fork raises no event.
 *
 * @module services/work-graph
 */
import type { Db } from '@dorkos/db';
import { entityRef } from '@dorkos/shared/entity-ref';
import { logger } from '../../lib/logger.js';
import {
  getSessionStartedByStore,
  onSessionStartRecorded,
} from '../session/origin/session-started-by-store.js';
import { onDurableSessionRekey } from '../session/turn-identity/durable-rekey.js';
import { registerDurableRekeyResolver } from '../session/turn-identity/follow-chat-rekey.js';
import { getRunRecord } from '../runs/index.js';
import { ChatLineageReader, type ChatLineage, type ChatLineageOptions } from './chat-lineage.js';
import { WorkLinkStore, type WorkLinkInput } from './work-link-store.js';

export {
  ChatLineageReader,
  LINEAGE_MAX_CHATS,
  LINEAGE_MAX_DEPTH,
  LINEAGE_MAX_VISITED,
  type ChatLineage,
  type ChatLineageDeps,
  type ChatLineageOptions,
  type LineageAncestor,
  type LineageDescendant,
  type LineageState,
  type LineageVia,
} from './chat-lineage.js';

export {
  REKEY_MAX_DEPTH,
  WORK_LINK_RELATIONS,
  WorkLinkStore,
  type WorkLink,
  type WorkLinkInput,
  type WorkLinkRecordResult,
  type WorkLinkRefusal,
  type WorkLinkRelation,
  type WorkLinkStoreDeps,
} from './work-link-store.js';
export { decodeWorkLinkRef, encodeWorkLinkRef } from './work-link-ref.js';

let store: WorkLinkStore | null = null;
/** The database the store was installed over: the lineage query reads chats' bindings from it. */
let installedDb: Db | null = null;
let stopRekeyWrites: (() => void) | null = null;
let stopRekeyReads: (() => void) | null = null;
let stopStartWrites: (() => void) | null = null;

/**
 * Install the edge store over the database, start recording re-keys and the
 * chats a chat starts, and answer `followChatRekey` from the recorded re-keys.
 * Called once at startup, before any runtime takes a turn. Installing again
 * replaces the store; the re-key participant, the start listener and the
 * resolver are registered once and read the current store.
 *
 * @param db - The DorkOS database.
 * @returns The installed store.
 */
export function installWorkLinkStore(db: Db): WorkLinkStore {
  store = new WorkLinkStore({ db });
  installedDb = db;
  stopRekeyWrites ??= onDurableSessionRekey((oldId, newId) => recordChatRekey(oldId, newId));
  stopRekeyReads ??= registerDurableRekeyResolver(
    (chatId) => store?.resolveRekey(chatId) ?? chatId
  );
  stopStartWrites ??= onSessionStartRecorded(({ sessionId, startedBySessionId, carried }) => {
    if (startedBySessionId !== null && !carried) recordChatStart(startedBySessionId, sessionId);
  });
  return store;
}

/** Remove the installed store and stop recording re-keys and starts and answering re-keys. For tests. */
export function uninstallWorkLinkStore(): void {
  stopStartWrites?.();
  stopStartWrites = null;
  stopRekeyWrites?.();
  stopRekeyWrites = null;
  stopRekeyReads?.();
  stopRekeyReads = null;
  store = null;
  installedDb = null;
}

/** The installed store, or `null` before startup installs it. */
export function getWorkLinkStore(): WorkLinkStore | null {
  return store;
}

/**
 * The database the store was installed over, or `null` before startup
 * installs it: what the read tools hand `./reads/chat-bindings.ts`.
 */
export function getWorkGraphDb(): Db | null {
  return installedDb;
}

/**
 * A chat's ancestors and its subtree with depth, read from this server's
 * stores: the installed edge store, `session_started_by` and the run record.
 * See {@link ChatLineageReader} for what is shown and what is left out.
 *
 * @param chatId - The chat, by any id it has had.
 * @param opts - How many levels of descendants (all by default), and for whom.
 * @returns The lineage; `null` before startup installs the store, or when the
 *   chat has neither a binding nor a run, and nothing it started is shown.
 */
export function readChatLineage(chatId: string, opts?: ChatLineageOptions): ChatLineage | null {
  if (store === null || installedDb === null) return null;
  const startedBy = getSessionStartedByStore();
  const runs = getRunRecord()?.store;
  return new ChatLineageReader({
    db: installedDb,
    links: store,
    ...(startedBy ? { startedBy } : {}),
    ...(runs ? { runs } : {}),
  }).read(chatId, opts);
}

/**
 * Record one chat-to-chat edge, never throwing. A refusal or a database
 * failure is logged with `ids` (named for the action: `oldId`/`newId` for a
 * re-key, `sourceId`/`forkId` for a fork, `starterId`/`chatId` for a start)
 * and dropped.
 */
function recordChatLink(
  relation: 'rekeyed_from' | 'forked_from' | 'started',
  fromChatId: string,
  toChatId: string,
  ids: Record<string, string>
): void {
  if (store === null) return;
  const from = entityRef('chat', fromChatId);
  const to = entityRef('chat', toChatId);
  if (!from.ok || !to.ok) {
    logger.warn('[work-graph] a chat id has no reference form; edge not recorded', {
      relation,
      ...ids,
    });
    return;
  }
  const input: WorkLinkInput = { from: from.value, relation, to: to.value, source: 'server' };
  try {
    const result = store.record(input);
    if (!result.ok)
      logger.warn('[work-graph] edge refused', { relation, ...ids, reason: result.reason });
  } catch (err) {
    logger.warn('[work-graph] could not record an edge', {
      relation,
      ...ids,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record that a chat's id `newId` replaced its older id `oldId` (ADR-0267), so
 * an old reference can be resolved after a restart. A chat is re-keyed once,
 * so a second re-key of `oldId` to a different id is refused and logged, and
 * the first stands. Never throws.
 *
 * @param oldId - The id the chat had.
 * @param newId - The id it has now.
 */
export function recordChatRekey(oldId: string, newId: string): void {
  recordChatLink('rekeyed_from', newId, oldId, { oldId, newId });
}

/**
 * Record that `forkId` is a fork of `sourceId`, so a roll-up over a chat and
 * its children still finds the fork. Never throws.
 *
 * @param sourceId - The chat that was forked: the runtime's id for it, the one actually forked.
 * @param forkId - The new chat's id.
 */
export function recordChatFork(sourceId: string, forkId: string): void {
  recordChatLink('forked_from', forkId, sourceId, { sourceId, forkId });
}

/**
 * Record that `starterId` started `chatId`, so "which chats did this chat
 * start" can be answered from the graph. Never throws.
 */
function recordChatStart(starterId: string, chatId: string): void {
  recordChatLink('started', starterId, chatId, { starterId, chatId });
}
