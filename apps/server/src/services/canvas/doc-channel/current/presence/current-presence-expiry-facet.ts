import { createHash, randomUUID } from 'node:crypto';
import { StoredPageEventSchema } from '@dorkos/shared/canvas-channel-schemas';
import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import { requireCurrentDocEngineOrigin } from '../../authorization.js';
import { requireDocChannelStoreDatabase, type DocChannelStore } from '../../store.js';
import type { DocChannelActor } from '../../authorization.js';
import type { CurrentOperationScope } from '../current-operation-types.js';
import {
  withCheckboxReadOnlyGate,
  checkboxAuthoritySync,
} from '../../writes/authority/authority-snapshot.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current-operation-data.js';
import { documentTransaction } from '../../storage/store-transaction.js';
import { envelopeIdentity } from '../../envelope.js';
import { queueCommittedDocEvent } from '../../committed-events.js';
import { readOriginalPresenceExpiryFacet } from '../current-operation-engine.js';
/** Retire known mounted presence and return its captured caller evidence. */
export function retireKnownPresence(
  owner: object,
  documentId: string
): Readonly<{ retired: boolean; callers: ReadonlySet<string> }> {
  const facet = readOriginalPresenceExpiryFacet(owner);
  const own = facet.presenceDocuments.get(documentId);
  if (!own) throw new Error('Original presence lifecycle context missing');
  requireCurrentDocEngineOrigin(facet.authorization, facet.core, facet.db);
  requireDocChannelStoreDatabase(own.store, facet.db);
  requireServerNativeDatabaseQueryCustody(facet.db);
  const retirement = withCheckboxReadOnlyGate(facet.db, () => {
    const row = facet
      .nativePrepare(
        'SELECT channel.document_id,channel.scope,channel.created_at,channel.closed_at,channel.closure_evidence,physical.opened_at AS physical_opened_at,physical.scope AS physical_scope FROM canvas_doc_channels AS channel LEFT JOIN canvas_documents AS physical ON physical.id=channel.document_id WHERE channel.document_id=?'
      )
      .get(documentId);
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      !('document_id' in row) ||
      typeof row.document_id !== 'string' ||
      !('scope' in row) ||
      typeof row.scope !== 'string' ||
      !('created_at' in row) ||
      typeof row.created_at !== 'string' ||
      !('closed_at' in row) ||
      (row.closed_at !== null && typeof row.closed_at !== 'string') ||
      !('closure_evidence' in row) ||
      (row.closure_evidence !== null && typeof row.closure_evidence !== 'string') ||
      !('physical_opened_at' in row) ||
      (row.physical_opened_at !== null && typeof row.physical_opened_at !== 'string') ||
      !('physical_scope' in row) ||
      (row.physical_scope !== null && typeof row.physical_scope !== 'string')
    )
      throw new Error('Original presence lifecycle row incomplete');
    if (row.document_id !== own.birth.documentId || row.created_at !== own.birth.createdAt)
      throw new Error('Original presence lifecycle birth changed');
    if (row.physical_opened_at !== null && row.physical_opened_at !== own.birth.openedAt)
      throw new Error('Original presence physical birth changed');
    if (row.closed_at !== null) {
      if (!Number.isFinite(Date.parse(row.closed_at)) || row.closure_evidence === null)
        throw new Error('Original presence closure evidence incomplete');
      const evidence: unknown = JSON.parse(row.closure_evidence);
      if (
        !evidence ||
        typeof evidence !== 'object' ||
        Array.isArray(evidence) ||
        Object.keys(evidence).length !== 2 ||
        !('reason' in evidence) ||
        evidence.reason !== 'removed' ||
        !('scope' in evidence) ||
        evidence.scope !== row.scope
      )
        throw new Error('Original presence closure differs');
      // Actual original lifecycle.close retained this tombstone before physical deletion.
      // A closed document has no authorized live recipient; never append after closure.
      facet.presenceLedger.retire(documentId);
      facet.presenceDocuments.delete(documentId);
      return { retired: true, callers: [] };
    }
    if (row.physical_opened_at === null || row.physical_scope !== row.scope)
      throw new Error('Original live presence source incomplete');
    const retiredCallers: string[] = [];
    for (const [caller, actor] of own.callers) {
      const claims = actor.principal.claims;
      const principal = checkboxAuthoritySync(facet.fixedPorts.principalCurrent(actor.principal));
      if (principal !== true && principal !== false)
        throw new Error('Original presence principal state unknown');
      const installation = principal
        ? checkboxAuthoritySync(facet.fixedPorts.ownsInstallation(claims))
        : false;
      if (installation !== true && installation !== false)
        throw new Error('Original presence installation state unknown');
      let membershipMissing = false;
      if (principal && installation && row.scope.startsWith('room:')) {
        const key =
          claims.kind === 'operator'
            ? claims.owner.kind === 'user'
              ? 'user:' + claims.owner.userId
              : 'local'
            : claims.kind === 'agent' || claims.kind === 'runtime'
              ? claims.agentPath
              : undefined;
        if (key === undefined) throw new Error('Original presence member identity unknown');
        const kind = claims.kind === 'operator' ? 'human' : 'agent';
        const members = facet
          .nativePrepare(
            'SELECT a.id,a.minted_for_manifest_id FROM authors a JOIN room_members m ON m.author_id=a.id WHERE a.kind=? AND a.natural_key=? AND a.retired_at IS NULL AND m.room_id=? LIMIT 2'
          )
          .all(kind, key, row.scope.slice(5));
        if (members.length > 1) throw new Error('Original presence member identity ambiguous');
        if (!members.length) membershipMissing = true;
        else {
          const member = members[0];
          if (
            !member ||
            typeof member !== 'object' ||
            !('id' in member) ||
            typeof member.id !== 'string' ||
            !('minted_for_manifest_id' in member)
          )
            throw new Error('Original presence membership row incomplete');
          if (
            (claims.kind === 'agent' || claims.kind === 'runtime') &&
            member.minted_for_manifest_id !== claims.agentId
          )
            throw new Error('Original presence manifest membership differs');
        }
      }
      if (principal === false || installation === false || membershipMissing) {
        // These are positive original authority retirement results, never caught errors.
        retiredCallers.push(caller);
      }
    }
    const surviving = [...own.callers].find(([caller]) => !retiredCallers.includes(caller));
    if (surviving) own.actor = surviving[1];
    // Keep the original ledger until the surviving caller's native transaction commits
    // host.closed and the changed viewer count; SQL failure cannot lose that transition.
    return { retired: false, callers: retiredCallers };
  });
  // The native read-only gate admits plain DATA only, never Set instances.
  return { retired: retirement.retired, callers: new Set(retirement.callers) };
}
/** Expire the captured native presence through the original current document scope. */
export function expirePresenceNative(
  owner: object,
  documentId: string,
  own: {
    store: DocChannelStore;
    actor: DocChannelActor;
    birth: CurrentOperationScope['birth'];
    scope: string;
    callers: Map<string, DocChannelActor>;
  },
  retiredCallers: ReadonlySet<string>
): void {
  const facet = readOriginalPresenceExpiryFacet(owner);
  if (
    facet.roomPumpStopped ||
    facet.presenceDocuments.get(documentId) !== own ||
    facet.db.$client.inTransaction ||
    facet.currentEntry
  )
    throw new Error('Original presence expiry owner changed');
  requireCurrentDocEngineOrigin(facet.authorization, facet.core, facet.db);
  requireDocChannelStoreDatabase(own.store, facet.db);
  requireServerNativeDatabaseQueryCustody(facet.db);
  const now = facet.presenceNow();
  const plan = facet.presenceLedger.expire(documentId, now, retiredCallers);
  if (!plan) {
    facet.schedulePresence();
    return;
  }
  facet.presenceLedger.requireExpiry(plan);
  // This constructor's own timer/ledger produces only quiet system lifecycle rows.
  // It never reuses a retired request actor, selects routes, or enters ingestion.
  facet.currentEntry = true;
  try {
    documentTransaction(facet.db, () => {
      const physical = facet
        .nativePrepare('SELECT * FROM canvas_documents WHERE id=?')
        .get(documentId);
      const channel = facet
        .nativePrepare('SELECT * FROM canvas_doc_channels WHERE document_id=?')
        .get(documentId);
      if (
        !physical ||
        typeof physical !== 'object' ||
        !('id' in physical) ||
        physical.id !== own.birth.physicalId ||
        !('opened_at' in physical) ||
        physical.opened_at !== own.birth.openedAt ||
        !('scope' in physical) ||
        typeof physical.scope !== 'string' ||
        !channel ||
        typeof channel !== 'object' ||
        !('document_id' in channel) ||
        channel.document_id !== own.birth.documentId ||
        !('created_at' in channel) ||
        channel.created_at !== own.birth.createdAt ||
        !('scope' in channel) ||
        channel.scope !== physical.scope ||
        !('closed_at' in channel) ||
        channel.closed_at !== null ||
        !('next_doc_seq' in channel) ||
        typeof channel.next_doc_seq !== 'number' ||
        !Number.isSafeInteger(channel.next_doc_seq) ||
        channel.next_doc_seq < 1
      )
        throw new Error('Original live presence expiry source differs');
      const source = copyCurrentDocData(physical),
        beforeChannel = copyCurrentDocData(channel);
      const nextSequence = channel.next_doc_seq;
      const fingerprint = (query: string, ...params: (string | number)[]) => {
        const hash = createHash('sha256');
        let count = 0;
        // Each complete row is bounded individually; a retained history does not
        // become an accidental whole-log JSON byte limit on quiet expiry.
        for (const row of facet.nativePrepare(query).iterate(...params)) {
          hash.update(JSON.stringify(copyCurrentDocData(row))).update('\n');
          count++;
        }
        return count + ':' + hash.digest('hex');
      };
      const oldEventsQuery =
        'SELECT * FROM canvas_doc_events WHERE document_id=? AND doc_seq<? ORDER BY doc_seq';
      const batchesQuery = 'SELECT * FROM canvas_doc_batches WHERE document_id=? ORDER BY batch_id';
      const deliveriesQuery =
        'SELECT * FROM canvas_doc_deliveries WHERE document_id=? ORDER BY event_id,route_id';
      const events = fingerprint(oldEventsQuery, documentId, nextSequence);
      const batches = fingerprint(batchesQuery, documentId);
      const deliveries = fingerprint(deliveriesQuery, documentId);
      const transitions = [
        { type: 'host.closed', payload: { mounts: plan.closed } },
        ...(plan.countChanged ? [{ type: 'doc.viewers', payload: { views: plan.views } }] : []),
      ];
      const receivedAt = new Date(now).toISOString();
      const intended = transitions.map((transition, index) => {
        const event = StoredPageEventSchema.parse({ v: 1, id: randomUUID(), ...transition });
        const identity = envelopeIdentity(event);
        return {
          document_id: documentId,
          event_id: event.id,
          doc_seq: nextSequence + index,
          direction: 'system',
          type: event.type,
          payload: JSON.stringify(event.payload),
          envelope_hash: identity.hash,
          envelope_bytes: identity.bytes,
          payload_pruned_at: null,
          coalesce_key: null,
          client_ts: null,
          received_at: receivedAt,
          provenance: JSON.stringify({ source: 'doc-channel-presence' }),
        };
      });
      facet.presenceLedger.requireExpiry(plan);
      if (facet.roomPumpStopped) throw new Error('Original presence expiry retired before effect');
      const changed = facet
        .nativePrepare(
          'UPDATE canvas_doc_channels SET next_doc_seq=?,updated_at=? WHERE document_id=? AND next_doc_seq=? AND closed_at IS NULL'
        )
        .run(nextSequence + intended.length, receivedAt, documentId, nextSequence).changes;
      if (changed !== 1) throw new Error('Original presence expiry sequence raced');
      for (const row of intended)
        facet
          .nativePrepare(
            'INSERT INTO canvas_doc_events (document_id,event_id,doc_seq,direction,type,payload,envelope_hash,envelope_bytes,payload_pruned_at,coalesce_key,client_ts,received_at,provenance) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
          )
          .run(
            row.document_id,
            row.event_id,
            row.doc_seq,
            row.direction,
            row.type,
            row.payload,
            row.envelope_hash,
            row.envelope_bytes,
            row.payload_pruned_at,
            row.coalesce_key,
            row.client_ts,
            row.received_at,
            row.provenance
          );
      facet.presenceLedger.requireExpiry(plan);
      if (
        facet.roomPumpStopped ||
        facet.presenceDocuments.get(documentId) !== own ||
        !sameCurrentDocData(
          source,
          facet.nativePrepare('SELECT * FROM canvas_documents WHERE id=?').get(documentId)
        ) ||
        !sameCurrentDocData(
          {
            ...beforeChannel,
            next_doc_seq: nextSequence + intended.length,
            updated_at: receivedAt,
          },
          facet
            .nativePrepare('SELECT * FROM canvas_doc_channels WHERE document_id=?')
            .get(documentId)
        ) ||
        events !== fingerprint(oldEventsQuery, documentId, nextSequence) ||
        !sameCurrentDocData(
          intended,
          facet
            .nativePrepare(
              'SELECT * FROM canvas_doc_events WHERE document_id=? AND doc_seq>=? ORDER BY doc_seq'
            )
            .all(documentId, nextSequence)
        ) ||
        batches !== fingerprint(batchesQuery, documentId) ||
        deliveries !== fingerprint(deliveriesQuery, documentId)
      )
        throw new Error('Original presence expiry native rows changed');
      for (const row of intended)
        queueCommittedDocEvent(facet.db, {
          documentId,
          eventId: row.event_id,
          docSeq: row.doc_seq,
          direction: 'system',
          type: row.type,
          envelopeHash: row.envelope_hash,
          receivedAt,
        });
    });
    facet.presenceLedger.commit(plan);
    if (plan.views) {
      for (const caller of own.callers.keys())
        if (!facet.presenceLedger.hasCaller(documentId, caller)) own.callers.delete(caller);
    } else facet.presenceDocuments.delete(documentId);
  } finally {
    facet.currentEntry = false;
  }
  facet.schedulePresence();
}
