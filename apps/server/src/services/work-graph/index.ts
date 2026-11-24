/**
 * The work graph (DOR-4966; ADR 261124-131941): what a chat started, claims,
 * opened, works on and produced, as append-only edges between entity
 * references. This barrel installs the edge store and owns its write sites.
 *
 * Every write site here follows one rule: recording the edge never decides the
 * action. A write that fails is logged and dropped, and the re-key or the fork
 * it describes goes on, because a chat must not fail for want of its own record.
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
 *
 * The store lives in this computer's SQLite store for now; its move to the
 * space store is DOR-5139 (ADR 261122-173853).
 *
 * @module services/work-graph
 */
import type { Db } from '@dorkos/db';
import { entityRef } from '@dorkos/shared/entity-ref';
import { logger } from '../../lib/logger.js';
import { onDurableSessionRekey } from '../session/turn-identity/durable-rekey.js';
import { WorkLinkStore, type WorkLinkInput } from './work-link-store.js';

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
let stopRekeyWrites: (() => void) | null = null;

/**
 * Install the edge store over the database and start recording re-keys.
 * Called once at startup, before any runtime takes a turn. Installing again
 * replaces the store; the re-key participant is registered once.
 *
 * @param db - The DorkOS database.
 * @returns The installed store.
 */
export function installWorkLinkStore(db: Db): WorkLinkStore {
  store = new WorkLinkStore({ db });
  stopRekeyWrites ??= onDurableSessionRekey((fromId, toId) => recordChatRekey(fromId, toId));
  return store;
}

/** Remove the installed store and stop recording re-keys. For tests. */
export function uninstallWorkLinkStore(): void {
  stopRekeyWrites?.();
  stopRekeyWrites = null;
  store = null;
}

/** The installed store, or `null` before startup installs it. */
export function getWorkLinkStore(): WorkLinkStore | null {
  return store;
}

/**
 * Record one chat-to-chat edge, never throwing. A refusal or a database
 * failure is logged with the ids and dropped.
 */
function recordChatLink(
  relation: 'rekeyed_from' | 'forked_from',
  fromChatId: string,
  toChatId: string
): void {
  if (store === null) return;
  const from = entityRef('chat', fromChatId);
  const to = entityRef('chat', toChatId);
  if (!from.ok || !to.ok) {
    logger.warn('[work-graph] a chat id has no reference form; edge not recorded', {
      relation,
      fromChatId,
      toChatId,
    });
    return;
  }
  const input: WorkLinkInput = { from: from.value, relation, to: to.value, source: 'server' };
  try {
    const result = store.record(input);
    if (!result.ok)
      logger.warn('[work-graph] edge refused', {
        relation,
        fromChatId,
        toChatId,
        reason: result.reason,
      });
  } catch (err) {
    logger.warn('[work-graph] could not record an edge', {
      relation,
      fromChatId,
      toChatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record that a chat's id `toId` replaced its older id `fromId` (ADR-0267), so
 * an old reference resolves after a restart. Never throws.
 *
 * @param fromId - The id the chat had.
 * @param toId - The id it has now.
 */
export function recordChatRekey(fromId: string, toId: string): void {
  recordChatLink('rekeyed_from', toId, fromId);
}

/**
 * Record that `forkId` is a fork of `sourceId`, so a roll-up over a chat and
 * its children still finds the fork. Never throws.
 *
 * @param sourceId - The chat that was forked, as its caller named it.
 * @param forkId - The new chat's id.
 */
export function recordChatFork(sourceId: string, forkId: string): void {
  recordChatLink('forked_from', forkId, sourceId);
}
