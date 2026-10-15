/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */

import { requireOriginalConsumerControls } from '../channel-store.js';
/** Original fixed presence controls; no supplied mutable context or original-key issuer. */
export function createOriginalConsumerPresenceControls(ownerKey: object) {
  const context = requireOriginalConsumerControls(ownerKey);
  const {
    db,
    http,
    documentId,
    suspendPrivateDispatches,
    admission,
    pumpLifetime,
    widgetPresenceNativeEvents,
  } = context;
  return {
    stopOriginalSavedDispatch() {
      if (context.savedRetirement) return context.savedRetirement;
      context.savedRetired = true;
      context.savedRetirement = (async () => {
        if (!context.savedOpenStarted) return;
        let failed = false,
          first: unknown;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            first = cause;
          }
        };
        try {
          pumpLifetime.abort();
        } catch (cause) {
          remember(cause);
        }
        if (context.savedPumpStarted) {
          try {
            await suspendPrivateDispatches(pumpLifetime.signal);
            context.savedDispatchClosed = true;
          } catch (cause) {
            remember(cause);
          }
        }
        if (failed) throw first;
      })();
      return context.savedRetirement;
    },
    /** Fixed private count audit of the actual mounted widget, not a caller-selected ID. */
    readOriginalPresenceData() {
      if (context.closed || !context.widgetDocumentId)
        throw new Error('Original presence widget unavailable');
      const rows = db.$client
        .prepare('SELECT * FROM canvas_doc_events WHERE document_id=? ORDER BY doc_seq LIMIT 34')
        .all(context.widgetDocumentId);
      if (rows.length > 33) throw new Error('Original presence full event audit bound');
      const presenceRows = rows.filter((row) => {
        if (
          !row ||
          typeof row !== 'object' ||
          !('type' in row) ||
          typeof row.type !== 'string' ||
          !('event_id' in row) ||
          typeof row.event_id !== 'string'
        )
          throw new Error('Original presence row incomplete');
        if (['host.opened', 'host.closed', 'doc.viewers', 'host.focus'].includes(row.type))
          return true;
        // Only this fixture's actual original MCP receipt can account for its full state row.
        if (widgetPresenceNativeEvents.get(row.event_id) !== JSON.stringify(row))
          throw new Error('Original presence whole-log event differs');
        return false;
      });
      if (
        presenceRows.length > 32 ||
        rows.length !== presenceRows.length + widgetPresenceNativeEvents.size
      )
        throw new Error('Original presence whole-log count differs');
      const events = presenceRows.map((row) => {
        if (
          !row ||
          typeof row !== 'object' ||
          !('type' in row) ||
          typeof row.type !== 'string' ||
          !('direction' in row) ||
          typeof row.direction !== 'string' ||
          !('payload' in row) ||
          typeof row.payload !== 'string' ||
          !('provenance' in row) ||
          typeof row.provenance !== 'string'
        )
          throw new Error('Original presence native row incomplete');
        const payload: unknown = JSON.parse(row.payload);
        const provenance: unknown = JSON.parse(row.provenance);
        if (row.type === 'host.focus') {
          if (
            row.direction !== 'upstream' ||
            !payload ||
            typeof payload !== 'object' ||
            Array.isArray(payload) ||
            Object.keys(payload).length !== 1 ||
            !('focused' in payload) ||
            typeof payload.focused !== 'boolean' ||
            JSON.stringify(provenance) !==
              JSON.stringify({ transport: 'http', trust: 'app_untrusted' })
          )
            throw new Error('Original host focus audit differs');
        } else {
          const key = row.type === 'doc.viewers' ? 'views' : 'mounts';
          if (
            row.direction !== 'system' ||
            !payload ||
            typeof payload !== 'object' ||
            Array.isArray(payload) ||
            Object.keys(payload).length !== 1 ||
            !(key in payload) ||
            typeof Reflect.get(payload, key) !== 'number' ||
            !Number.isSafeInteger(Reflect.get(payload, key)) ||
            Reflect.get(payload, key) < (key === 'views' ? 0 : 1) ||
            JSON.stringify(provenance) !== JSON.stringify({ source: 'doc-channel-presence' })
          )
            throw new Error('Original quiet presence audit differs');
        }
        return { type: row.type, payload };
      });
      const native = db.$client
        .prepare(
          "SELECT (SELECT count(*) FROM canvas_doc_batches WHERE document_id=?) AS batches,(SELECT count(*) FROM session_message_acceptance_receipts WHERE source_kind='document_event_batch' AND source_id IN (SELECT batch_id FROM canvas_doc_batches WHERE document_id=?)) AS admissions"
        )
        .get(context.widgetDocumentId, context.widgetDocumentId);
      if (
        !native ||
        typeof native !== 'object' ||
        !('batches' in native) ||
        typeof native.batches !== 'number' ||
        !('admissions' in native) ||
        typeof native.admissions !== 'number' ||
        !Number.isSafeInteger(native.batches) ||
        !Number.isSafeInteger(native.admissions)
      )
        throw new Error('Original presence admission census missing');
      return {
        documentId: context.widgetDocumentId,
        events,
        batches: native.batches,
        admissions: native.admissions,
      };
    },
    /** Genuine agent-born FILE; only the operator UI approves its doc.saved route. */
  };
}
