/** Fixed lifecycle methods; original constructor retains every native issuer and private map. */
import { type RoomDocRow } from './room-doc-rows.js';
import type { NativeRoomDocCommit, RoomDocEmissionOutcome } from './room-doc-types.js';
import {
  roomRowIdentity as identity,
  assertLifecycleAdmissionRow,
  assertLifecycleRowJson,
} from './room-doc-lifecycle-data.js';
import { requireRoomDocLifecycleOwner } from './room-doc-lifecycle.js';

/** Create committed-emission methods for the authenticated original lifecycle owner. */
export function createRoomDocEmissionLifecycle(ownerKey: object) {
  const context = requireRoomDocLifecycleOwner(ownerKey);
  const { native, execute, guard, requireCommit, failure, unknownCommits } = context;
  return {
    runOriginalCommittedRoomEmission<T>(
      commit: NativeRoomDocCommit,
      work: (queryDb: object, sourceDb: object) => T
    ): RoomDocEmissionOutcome<T> {
      let frame: object | undefined;
      let beginAttempted = false;
      try {
        if (context.originalEmissionFrame || !context.ownDb || unknownCommits.has(commit))
          throw new Error('Room emission entry unavailable');
        const state = requireCommit(commit),
          data = state.data;
        guard();
        beginAttempted = true;
        frame = native.beginRoomFrame();
        guard(frame);
        const admission = execute('lifecycle-admission', { admissionId: data.admissionId }) as
          RoomDocRow | undefined;
        assertLifecycleAdmissionRow(admission, data, state.bootEpoch, state.rowId);
        assertLifecycleRowJson(admission);
        const batch = execute('source-batch', data) as RoomDocRow | undefined;
        const inputs = execute('ordered-source-inputs', data) as RoomDocRow[];
        const links = execute('final-ordered-links', data) as RoomDocRow[];
        if (
          !batch ||
          batch.document_id !== data.documentId ||
          batch.batch_id !== data.batchId ||
          batch.generation !== data.generation ||
          batch.room_admission_id !== data.admissionId ||
          batch.room_source_hash !== data.originalSourceHash ||
          batch.room_source_json !== data.originalSourceJson ||
          batch.grant_id !== data.grantId ||
          batch.grant_revision !== data.grantRevision ||
          batch.route_id !== data.routeId ||
          batch.input_event_ids !== data.inputEventIdsJson ||
          batch.effective_payload !== data.effectivePayloadJson ||
          batch.scope !== data.scope ||
          batch.status !== (admission.status === 'claimed' ? 'dispatching' : 'turn_started') ||
          inputs.length !== data.inputs.length ||
          links.length !== data.inputs.length
        )
          throw new Error('Room emission original capsule changed');
        for (const [ordinal, input] of data.inputs.entries()) {
          const row = inputs[ordinal],
            link = links[ordinal];
          if (
            !row ||
            row.ordinal !== ordinal ||
            row.event_id !== input.eventId ||
            row.doc_seq !== input.docSeq ||
            row.envelope_hash !== input.envelopeHash ||
            row.type !== input.type ||
            row.direction !== input.direction ||
            row.payload !== input.payload ||
            row.provenance !== input.provenance ||
            row.payload_pruned_at !== null ||
            row.route_id !== data.routeId ||
            row.batch_id !== data.batchId ||
            row.room_admission_id !== data.admissionId ||
            row.delivery_kind !== 'room_app_event' ||
            row.status !== (admission.status === 'claimed' ? input.status : 'turn_started') ||
            row.reason !==
              (admission.status === 'claimed' ? 'room_doc_claimed' : 'room_doc_turn_started') ||
            row.turn_id !== admission.turn_id ||
            !link ||
            link.admission_id !== data.admissionId ||
            link.document_id !== data.documentId ||
            link.event_id !== input.eventId ||
            link.route_id !== data.routeId ||
            link.input_ordinal !== ordinal ||
            link.doc_seq !== input.docSeq ||
            link.envelope_hash !== input.envelopeHash ||
            link.source_delivery_status !== input.status ||
            link.source_delivery_reason !== input.reason
          )
            throw new Error('Room emission original input custody changed');
        }
        context.originalEmissionFrame = frame;
        let result: T;
        try {
          result = native.withRoomFrameQueries(frame, (queryDb) => work(queryDb, context.ownDb!));
          if (
            result &&
            (typeof result === 'object' || typeof result === 'function') &&
            'then' in result
          ) {
            void Promise.resolve(result).catch(() => {});
            throw new Error('Room native emission must be synchronous');
          }
        } finally {
          context.originalEmissionFrame = undefined;
        }
        guard(frame);
        if (
          requireCommit(commit) !== state ||
          unknownCommits.has(commit) ||
          identity(execute('lifecycle-admission', { admissionId: data.admissionId })) !==
            identity(admission) ||
          identity(execute('source-batch', data)) !== identity(batch) ||
          identity(execute('final-ordered-links', data)) !== identity(links)
        )
          throw new Error('Room emission immutable custody changed');
        const finalInputs = execute('ordered-source-inputs', data) as RoomDocRow[];
        if (finalInputs.length !== inputs.length)
          throw new Error('Room emission input set changed');
        for (const [ordinal, row] of inputs.entries()) {
          const final = finalInputs[ordinal];
          for (const key of Object.keys(row)) {
            if (['ack_outcome', 'acknowledged_at', 'acknowledged_by', 'ack_evidence'].includes(key))
              continue;
            if (final[key] !== row[key]) throw new Error('Room emission input identity changed');
          }
        }
        native.commitRoomFrame(frame);
        return { state: 'confirmed', value: result };
      } catch (cause) {
        context.originalEmissionFrame = undefined;
        if (!beginAttempted) return { state: 'refused', cause };
        const failed = failure(frame);
        return { state: failed.state === 'refused' ? 'refused' : 'unknown', cause };
      } finally {
        context.originalEmissionFrame = undefined;
      }
    },
  };
}
