/** Fixed lifecycle methods; original constructor retains every native issuer and private map. */
import { createHash } from 'node:crypto';
import { decodeDurableAcceptedRoomSource } from './room-doc-data.js';
import { sourceRowAgrees, inputRowsAgree, type RoomDocRow } from './room-doc-rows.js';
import type { RoomDocNative as Native } from './room-doc-types.js';
import {
  roomRowIdentity as identity,
  roomSelectorString as selector,
} from './room-doc-lifecycle-data.js';
import { requireRoomDocLifecycleOwner } from './room-doc-lifecycle.js';

/** Create original-owner undo cancellation methods that retain native frame and receipt custody. */
export function createRoomDocUndoLifecycle(ownerKey: object) {
  const context = requireRoomDocLifecycleOwner(ownerKey);
  const { native, execute, guard, failure, run, clock, iso, producerRows } = context;
  return {
    cancelOriginalCheckboxUndoPair(
      input: import('./room-doc-types.js').OriginalCheckboxUndoPairData
    ) {
      let frame: object | undefined;
      try {
        // Data does not issue custody. This method belongs to the never-exposed original native facade.
        const captureJson = (value: string) => {
          if (typeof value !== 'string' || !value.length || value.length > 2097152)
            throw new Error('Unbounded original undo comparison');
          return JSON.parse(value);
        };
        const data = {
          documentId: selector(input.documentId),
          intentId: selector(input.intentId),
          documentGeneration: selector(input.documentGeneration),
          currentIntent: captureJson(input.currentIntentJson),
          physical: captureJson(input.physicalJson),
          birth: captureJson(input.channelBirthJson),
        };
        const ordered = (value: unknown): unknown =>
          Array.isArray(value)
            ? value.map(ordered)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                  Object.keys(value)
                    .sort()
                    .map((key) => [key, ordered((value as Record<string, unknown>)[key])])
                )
              : value;
        const equal = (a: unknown, b: unknown) => identity(ordered(a)) === identity(ordered(b));
        const parse = (value: unknown) => {
          if (typeof value !== 'string') throw new Error('Missing native undo JSON');
          return JSON.parse(value);
        };
        const intentData = (row: RoomDocRow) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
              key === 'input' || key === 'evidence' || key === 'source_identity'
                ? parse(value)
                : value,
            ])
          );
        guard();
        frame = native.beginRoomFrame();
        guard(frame);
        const changesBefore = (execute('undo-total-changes') as { total: number }).total;
        if (!Number.isSafeInteger(changesBefore))
          throw new Error('Original undo write census unavailable');
        if ((execute('undo-writer-triggers') as unknown[]).length)
          throw new Error('Unsupported original writer trigger');
        const document = execute('fixed-document', data) as RoomDocRow | undefined;
        const channel = execute('fixed-channel', data) as RoomDocRow | undefined;
        if (
          !document ||
          !channel ||
          channel.closed_at !== null ||
          !equal(document, data.physical) ||
          !equal(
            Object.fromEntries(Object.keys(data.birth).map((key) => [key, channel[key]])),
            data.birth
          )
        )
          throw new Error('Original undo physical or channel birth changed');
        const current = execute('undo-original-intent', data) as RoomDocRow | undefined;
        if (!current || !equal(intentData(current), data.currentIntent))
          throw new Error('Original committed undo intent changed');
        const rows = execute('undo-writer-intents', {
          ...data,
          beforeHash: current.after_hash,
          afterHash: current.before_hash,
          canonicalPath: current.canonical_path,
          grantId: current.grant_id,
        }) as RoomDocRow[];
        if (rows.length > 1024) throw new Error('Unbounded original writer history');
        const qualify = (row: RoomDocRow) => {
          const request = parse(row.input),
            evidence = parse(row.evidence);
          const event = execute('undo-original-event', { ...data, eventId: row.event_id }) as
            RoomDocRow | undefined;
          const receipt = evidence.receipt;
          const payload = {
            line: request.line,
            done: request.done,
            textHash: request.textHash,
            beforeFileVersion: row.before_hash,
            afterFileVersion: row.after_hash,
          };
          const envelope = identity(
            ordered({ v: 1, id: row.event_id, type: 'md.task.toggled', payload })
          );
          if (
            row.status !== 'committed' ||
            row.document_id !== data.documentId ||
            evidence.v !== 2 ||
            evidence.preEffectRefusal ||
            evidence.authority.documentGeneration !== data.documentGeneration ||
            row.error_code !== null ||
            row.operation !== 'checkbox-toggle' ||
            request.documentId !== data.documentId ||
            request.eventId !== row.event_id ||
            typeof request.done !== 'boolean' ||
            !Number.isSafeInteger(request.line) ||
            request.line < 0 ||
            request.expectedFileVersion !== row.before_hash ||
            row.expected_version !== row.before_hash ||
            row.envelope_hash !== createHash('sha256').update(identity(request)).digest('hex') ||
            evidence.authority.documentId !== data.documentId ||
            evidence.authority.grantId !== row.grant_id ||
            evidence.authority.binding.canonicalPath !== row.canonical_path ||
            !equal(evidence.authority.binding.sourceIdentity, parse(row.source_identity)) ||
            evidence.authority.binding.resolvedCwd !== row.resolved_cwd ||
            evidence.authority.binding.treeKind !== row.tree_kind ||
            evidence.authority.binding.operation !== row.operation ||
            !evidence.originalIdentity ||
            !evidence.tempIdentity ||
            evidence.lineHash !== request.textHash ||
            !Number.isSafeInteger(evidence.markerOffset) ||
            evidence.markerOffset < 0 ||
            ![32, 88, 120].includes(evidence.beforeMarker) ||
            row.before_hash === row.after_hash ||
            receipt?.status !== 'changed' ||
            receipt.fileVersion !== row.after_hash ||
            receipt.receipt?.status !== 'recorded' ||
            receipt.receipt.id !== row.event_id ||
            !event ||
            event.event_id !== row.event_id ||
            typeof event.doc_seq !== 'number' ||
            !Number.isSafeInteger(event.doc_seq) ||
            event.doc_seq <= 0 ||
            event.doc_seq !== receipt.receipt.docSeq ||
            event.direction !== 'upstream' ||
            event.type !== 'md.task.toggled' ||
            event.payload_pruned_at !== null ||
            event.coalesce_key !== null ||
            event.client_ts !== null ||
            !equal(parse(event.payload), payload) ||
            !equal(parse(event.provenance), {
              transport: 'host',
              producer: 'verified_checkbox',
              intentId: row.intent_id,
            }) ||
            event.envelope_hash !== createHash('sha256').update(envelope).digest('hex') ||
            event.envelope_bytes !== Buffer.byteLength(envelope)
          )
            throw new Error('Native original checkbox receipt is unqualified');
          return { row, request, evidence, event, docSeq: event.doc_seq as number };
        };
        const second = qualify(current);
        const matches = rows
          .filter(
            (row) =>
              row.intent_id !== data.intentId &&
              row.before_hash === current.after_hash &&
              row.after_hash === current.before_hash &&
              row.canonical_path === current.canonical_path &&
              row.grant_id === current.grant_id
          )
          .map(qualify)
          .filter(
            (first) =>
              first.docSeq < second.docSeq &&
              first.request.line === second.request.line &&
              first.evidence.markerOffset === second.evidence.markerOffset &&
              first.request.done !== second.request.done &&
              equal(first.evidence.authority, second.evidence.authority) &&
              equal(first.evidence.tempIdentity, second.evidence.originalIdentity)
          );
        if (matches.length !== 1) throw new Error('Original undo pair is absent or ambiguous');
        const first = matches[0],
          pair = new Set([String(first.row.event_id), String(current.event_id)]);
        const deliveries = [first, second].map(
          (item) =>
            execute('undo-original-deliveries', {
              ...data,
              eventId: item.row.event_id,
            }) as RoomDocRow[]
        );
        if (
          deliveries.some((slice) => slice.length !== 1) ||
          deliveries[0][0].route_id !== deliveries[1][0].route_id
        )
          throw new Error('Original undo pair route changed');
        const batches = new Map<string, RoomDocRow>();
        for (const delivery of deliveries.flat()) {
          if (
            typeof delivery.batch_id !== 'string' ||
            !['pending', 'waiting', 'superseded'].includes(String(delivery.status)) ||
            delivery.turn_id !== null ||
            delivery.ack_outcome !== null ||
            delivery.ack_evidence !== null ||
            delivery.acknowledged_at !== null ||
            delivery.acknowledged_by !== null
          )
            throw new Error('Original undo pair is already claimed or acknowledged');
          // Generation comes from the original native row, never a caller-supplied batch key.
          const selected = execute('undo-delivery-batch', {
            ...data,
            batchId: delivery.batch_id,
          }) as RoomDocRow | undefined;
          if (!selected) throw new Error('Original undo batch is missing');
          batches.set(String(selected.batch_id), selected);
        }
        const keys: import('./room-doc-types.js').AcceptedRoomSourceKey[] = [];
        for (const batch of batches.values()) {
          const key = {
            documentId: data.documentId,
            batchId: String(batch.batch_id),
            generation: String(batch.generation),
          };
          const slice = execute('fixed-status-deliveries', key) as RoomDocRow[];
          const ids = parse(batch.input_event_ids);
          if (
            !['pending', 'waiting', 'accepted'].includes(String(batch.status)) ||
            batch.admission_receipt_id !== null ||
            batch.turn_id !== null ||
            batch.lease_until !== null ||
            batch.grant_id !== current.grant_id ||
            batch.route_id !== deliveries[0][0].route_id ||
            batch.grant_revision !== second.evidence.authority.grantRevision ||
            batch.scope !== channel.scope ||
            !Array.isArray(ids) ||
            !ids.length ||
            ids.length > 2 ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => !pair.has(String(id))) ||
            !slice.length ||
            slice.length > 2 ||
            slice.some((row) => !pair.has(String(row.event_id))) ||
            (execute('undo-batch-claims', key) as unknown[]).length
          )
            throw new Error('Mixed or claimed undo batch cannot be cancelled');
          if (batch.status === 'accepted') {
            const source = decodeDurableAcceptedRoomSource(batch);
            const capsule = parse(source.originalSourceJson);
            if (
              !equal(capsule.preEffectRows.document, data.physical) ||
              !equal(capsule.preEffectRows.channelBirth, data.birth) ||
              source.scope !== channel.scope ||
              source.grantId !== current.grant_id ||
              source.routeHash !== second.evidence.authority.routeHash ||
              !sourceRowAgrees(batch, source, 'accepted') ||
              !inputRowsAgree(execute('ordered-source-inputs', source) as RoomDocRow[], source)
            )
              throw new Error('Original accepted undo custody changed');
            producerRows(source);
          } else if (
            batch.delivery_kind !== null ||
            batch.room_admission_id !== null ||
            batch.room_source_json !== null ||
            batch.room_source_hash !== null ||
            batch.room_source_attempt !== null
          )
            throw new Error('Pending undo batch has foreign custody');
          keys.push(key);
        }
        const nowIso = iso(clock());
        for (const batch of batches.values())
          run(
            'undo-cancel-exact-batch',
            {
              documentId: data.documentId,
              batchId: batch.batch_id,
              generation: batch.generation,
              nowIso,
              oldStatus: batch.status,
              oldAttempt: batch.attempt,
              oldDeliveryKind: batch.delivery_kind,
              oldAdmissionId: batch.room_admission_id,
              oldSourceAttempt: batch.room_source_attempt,
              oldSourceJson: batch.room_source_json,
              oldSourceHash: batch.room_source_hash,
              oldInputEventIds: batch.input_event_ids,
              oldPayload: batch.effective_payload,
              oldError: batch.error_code,
              oldUpdatedAt: batch.updated_at,
            },
            1
          );
        for (const row of deliveries.flat())
          run(
            'undo-cancel-exact-delivery',
            {
              documentId: data.documentId,
              eventId: row.event_id,
              routeId: row.route_id,
              batchId: row.batch_id,
              nowIso,
              oldStatus: row.status,
              oldReason: row.reason,
              oldDeliveryKind: row.delivery_kind,
              oldAdmissionId: row.room_admission_id,
              oldUpdatedAt: row.updated_at,
            },
            1
          );
        // Original receipts, sequence and immutable source capsules are never rewritten.
        for (const row of [first.row, current])
          if (!equal(row, execute('undo-original-intent', { ...data, intentId: row.intent_id })))
            throw new Error('Original undo receipt changed during cancellation');
        for (const item of [first, second])
          if (
            !equal(
              item.event,
              execute('undo-original-event', { ...data, eventId: item.row.event_id })
            )
          )
            throw new Error('Original undo event changed during cancellation');
        for (const batch of batches.values())
          if (
            !equal(
              {
                ...batch,
                status: 'cancelled',
                error_code: 'checkbox_baseline_restored',
                updated_at: nowIso,
              },
              execute('undo-delivery-batch', { ...data, batchId: batch.batch_id })
            )
          )
            throw new Error('Original undo batch CAS changed immutable data');
        for (const row of deliveries.flat()) {
          const final = execute('undo-original-deliveries', {
            ...data,
            eventId: row.event_id,
          }) as RoomDocRow[];
          if (
            final.length !== 1 ||
            !equal(
              {
                ...row,
                status: 'cancelled',
                reason: 'checkbox_baseline_restored',
                updated_at: nowIso,
              },
              final[0]
            )
          )
            throw new Error('Original undo delivery CAS changed immutable data');
        }
        const changesAfter = (execute('undo-total-changes') as { total: number }).total;
        if (
          changesAfter - changesBefore !== batches.size + 2 ||
          !equal(document, execute('fixed-document', data)) ||
          !equal(channel, execute('fixed-channel', data))
        )
          throw new Error('Original undo cancellation changed unrelated native rows');
        guard(frame);
        native.commitRoomFrame(frame);
        return {
          state: 'confirmed' as const,
          value: Object.freeze(keys.map((key) => Object.freeze(key))),
        };
      } catch {
        return failure(frame);
      }
    },
  };
}
