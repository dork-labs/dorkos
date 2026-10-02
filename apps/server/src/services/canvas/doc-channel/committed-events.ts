/** Payload-free hints backed by committed SQLite rows, shared by a native connection. */
import type { Db, canvasDocChannels, canvasDocEvents, canvasDocGrants } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';

/** Observers reread authorized projections; a hint conveys no access or page data. */
export type CommittedDocEventListener = (documentId: string) => undefined;
type EventIdentity = Pick<
  typeof canvasDocEvents.$inferSelect,
  'documentId' | 'eventId' | 'docSeq' | 'envelopeHash' | 'direction' | 'type' | 'receivedAt'
>;
type GrantIdentity = Pick<
  typeof canvasDocGrants.$inferSelect,
  | 'documentId'
  | 'grantId'
  | 'revision'
  | 'routeHash'
  | 'declarationHash'
  | 'manifestHash'
  | 'createdAt'
  | 'revokedAt'
>;
type ChannelIdentity = Pick<typeof canvasDocChannels.$inferSelect, 'documentId' | 'createdAt'> &
  Partial<
    Pick<
      typeof canvasDocChannels.$inferSelect,
      'declarationHash' | 'manifestHash' | 'openerAgentId'
    >
  >;
type Candidate =
  | { kind: 'event'; identity: EventIdentity }
  | { kind: 'grant'; identity: GrantIdentity }
  | {
      kind: 'channel';
      identity: ChannelIdentity;
    };
interface Observers {
  client: Db['$client'];
  listeners: Set<CommittedDocEventListener>;
  pending: Candidate[];
  queued: boolean;
  retryMs: number;
  timer?: ReturnType<typeof setTimeout>;
}
const observers = new WeakMap<Db['$client'], Observers>();

function state(db: Db): Observers {
  let current = observers.get(db.$client);
  if (!current) {
    current = { client: db.$client, listeners: new Set(), pending: [], queued: false, retryMs: 5 };
    observers.set(db.$client, current);
  }
  return current;
}

/** Share subscriptions across every store or Drizzle wrapper on the actual SQLite connection. */
export function subscribeCommittedDocEvents(
  db: Db,
  listener: CommittedDocEventListener
): () => void {
  const current = state(db);
  const registered: CommittedDocEventListener = (documentId) => listener(documentId);
  current.listeners.add(registered);
  return () => {
    current.listeners.delete(registered);
    if (!current.listeners.size) {
      current.pending = [];
      clearTimeout(current.timer);
      current.timer = undefined;
      current.retryMs = 5;
    }
  };
}

function queue(db: Db, candidate: Candidate): void {
  const current = state(db);
  if (!current.listeners.size) return;
  current.pending.push(candidate);
  if (current.queued || current.timer) return;
  current.queued = true;
  queueMicrotask(() => {
    current.queued = false;
    flush(current);
  });
}

/** Register only immutable event identity after insertion; the surrounding transaction may still fail. */
export function queueCommittedDocEvent(db: Db, event: EventIdentity): void {
  const { documentId, eventId, docSeq, envelopeHash, direction, type, receivedAt } = event;
  queue(db, {
    kind: 'event',
    identity: { documentId, eventId, docSeq, envelopeHash, direction, type, receivedAt },
  });
}

/** A newly created channel can become visible before its first document event. */
export function queueCommittedDocChannel(db: Db, channel: ChannelIdentity): void {
  queue(db, {
    kind: 'channel',
    identity: {
      documentId: channel.documentId,
      createdAt: channel.createdAt,
      ...('declarationHash' in channel ? { declarationHash: channel.declarationHash } : {}),
      ...('manifestHash' in channel ? { manifestHash: channel.manifestHash } : {}),
      ...('openerAgentId' in channel ? { openerAgentId: channel.openerAgentId } : {}),
    },
  });
}

/** Persisted grant creation/revocation can change readiness without appending a document event. */
export function queueCommittedDocGrant(db: Db, grant: GrantIdentity): void {
  const {
    documentId,
    grantId,
    revision,
    routeHash,
    declarationHash,
    manifestHash,
    createdAt,
    revokedAt,
  } = grant;
  queue(db, {
    kind: 'grant',
    identity: {
      documentId,
      grantId,
      revision,
      routeHash,
      declarationHash,
      manifestHash,
      createdAt,
      revokedAt,
    },
  });
}

function flush(current: Observers): void {
  if (!current.listeners.size || !current.client.open) {
    current.pending = [];
    return;
  }
  if (current.client.inTransaction) {
    // A manual BEGIN may outlive this stack. One backed-off timer waits for commit/rollback.
    current.timer = setTimeout(() => {
      current.timer = undefined;
      flush(current);
    }, current.retryMs);
    current.timer.unref?.();
    current.retryMs = Math.min(1000, current.retryMs * 2);
    return;
  }
  current.retryMs = 5;
  const pending = current.pending;
  current.pending = [];
  const documents = new Set<string>();
  try {
    const event = current.client.prepare(`SELECT doc_seq AS docSeq, envelope_hash AS envelopeHash,
      direction, type, received_at AS receivedAt FROM canvas_doc_events
      WHERE document_id = ? AND event_id = ?`);
    const channel = current.client.prepare(
      `SELECT created_at AS createdAt, declaration_hash AS declarationHash,
      manifest_hash AS manifestHash, opener_agent_id AS openerAgentId FROM canvas_doc_channels WHERE document_id = ?`
    );
    const grant = current.client.prepare(`SELECT revision, route_hash AS routeHash,
      declaration_hash AS declarationHash, manifest_hash AS manifestHash,
      created_at AS createdAt, revoked_at AS revokedAt FROM canvas_doc_grants
      WHERE document_id = ? AND grant_id = ?`);
    for (const candidate of pending) {
      const identity = candidate.identity;
      if (documents.has(identity.documentId)) continue;
      if (candidate.kind === 'channel') {
        const identity = candidate.identity;
        const row = channel.get(identity.documentId) as ChannelIdentity | undefined;
        if (
          row?.createdAt === identity.createdAt &&
          (!('declarationHash' in identity) || row.declarationHash === identity.declarationHash) &&
          (!('manifestHash' in identity) || row.manifestHash === identity.manifestHash) &&
          (!('openerAgentId' in identity) || row.openerAgentId === identity.openerAgentId)
        )
          documents.add(identity.documentId);
      } else if (candidate.kind === 'grant') {
        const identity = candidate.identity;
        const row = grant.get(identity.documentId, identity.grantId) as
          Omit<GrantIdentity, 'documentId' | 'grantId'> | undefined;
        if (
          row &&
          row.revision === identity.revision &&
          row.routeHash === identity.routeHash &&
          row.declarationHash === identity.declarationHash &&
          row.manifestHash === identity.manifestHash &&
          row.createdAt === identity.createdAt &&
          row.revokedAt === identity.revokedAt
        )
          documents.add(identity.documentId);
      } else {
        const identity = candidate.identity;
        const row = event.get(identity.documentId, identity.eventId) as
          Omit<EventIdentity, 'documentId' | 'eventId'> | undefined;
        if (
          row &&
          row.docSeq === identity.docSeq &&
          row.envelopeHash === identity.envelopeHash &&
          row.direction === identity.direction &&
          row.type === identity.type &&
          row.receivedAt === identity.receivedAt
        )
          documents.add(identity.documentId);
      }
    }
  } catch {
    logger.warn('[canvas] committed document hint could not be verified');
    return;
  }
  for (const documentId of documents) {
    for (const listener of [...current.listeners]) {
      if (!current.listeners.has(listener)) continue;
      try {
        const result: unknown = listener(documentId);
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
          logger.warn('[canvas] document event observers must be synchronous');
        }
      } catch {
        logger.warn('[canvas] document event observer failed');
      }
    }
  }
}
