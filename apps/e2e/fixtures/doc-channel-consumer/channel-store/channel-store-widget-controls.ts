/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */

import { randomUUID } from 'node:crypto';

import { requireOriginalConsumerControls } from '../channel-store.js';
/** Original fixed widget controls; no supplied mutable context or original-key issuer. */
export function createOriginalConsumerWidgetControls(ownerKey: object) {
  const owner = requireOriginalConsumerControls(ownerKey);
  const {
    vault,
    hostBootstrap,
    target,
    replayServiceCurrentDoc,
    db,
    agentId,
    sessionId,
    rooms,
    approvals,
    http,
    actor,
    documentId,
    granted,
    initial,
    scenarioStore,
    runtime,
    widgetPresenceNativeEvents,
    acquireWidgetLock,
    releaseWidgetLock,
    DetachedTurnLifecycle,
    sendTestModeOriginalLockedMessage,
    resolveTestModeOriginalNativeStreamPrincipal,
    readTestModeOriginalNativeStream,
    invokeCapabilityAsMcpResult,
    widgetRegistry,
  } = owner;
  return {
    async openBoundWidget() {
      if (!hostBootstrap || target !== 'session' || owner.closed || owner.widgetOpenStarted)
        throw new Error('Original bound widget setup unavailable');
      owner.widgetOpenStarted = true;
      owner.widgetDocumentId = rooms.canvas.open(
        'session:' + sessionId,
        agentId,
        {
          type: 'widget',
          title: 'Native bound widget',
          definition: {
            version: 1,
            title: 'Native bound widget',
            root: {
              type: 'stack',
              direction: 'vertical',
              children: [
                { type: 'input', name: 'draft', label: 'Native widget draft' },
                {
                  type: 'button',
                  label: 'Native widget action',
                  action: { kind: 'emit', type: 'task.changed', payload: { widget: 'native' } },
                },
                {
                  type: 'text',
                  text: 'Waiting for native state',
                  bind: { text: { path: '/message' } },
                },
                ...Array.from({ length: 28 }, (_, index) => ({
                  type: 'text' as const,
                  text: 'Native widget row ' + index,
                })),
              ],
            },
          },
        },
        {
          tree: {
            resolvedCwd: vault.root,
            treeKind: 'agent-cwd',
            sourceLabel: null,
            aheadOfMain: null,
          },
        }
      ).id;
      http.grants.configure(
        owner.widgetDocumentId,
        {
          routes: [
            {
              id: 'widget',
              on: 'task.*',
              to: 'agent:owner',
              turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
            },
          ],
        },
        actor,
        agentId
      );
      const request = {
        documentId: owner.widgetDocumentId,
        routeId: 'widget',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      let granted = http.grants.grant(request, actor);
      if (granted.kind === 'approval_required') {
        approvals.grant(granted.ticket.approvalId);
        granted = http.grants.grant(request, actor, granted.ticket.token);
      }
      if (granted.kind !== 'granted') throw new Error('Original widget grant unavailable');
      owner.widgetGrantId = granted.grant.grantId;
      const current = await replayServiceCurrentDoc(http.service, owner.widgetDocumentId, actor);
      if (owner.closed || current.stateRev !== 0)
        throw new Error('Original widget initial state revision changed');
      return { documentId: owner.widgetDocumentId, stateRev: current.stateRev };
    },
    patchBoundWidget(next = false) {
      if (
        !hostBootstrap ||
        target !== 'session' ||
        owner.closed ||
        !owner.widgetDocumentId ||
        (next
          ? !owner.widgetPatchStarted || owner.widgetNextStarted || !owner.widgetProducerClosed
          : owner.widgetPatchStarted)
      )
        throw new Error('Original bound widget state action unavailable');
      if (next) owner.widgetNextStarted = true;
      else owner.widgetPatchStarted = true;
      owner.widgetPatchWork = (async () => {
        const holder = new DetachedTurnLifecycle();
        const clientId = 'owned-native-widget';
        let stream: ReturnType<typeof sendTestModeOriginalLockedMessage> = undefined;
        const streamRetirement: { returnStream?: () => Promise<unknown> } = {};
        let acquired = false;
        let producerStop: Promise<void> | undefined;
        owner.widgetProducerClosed = false;
        // Retain drain before acquiring the actual runtime lock or opening the native source.
        owner.stopWidgetProducer = () => {
          if (producerStop) return producerStop;
          let resolve!: () => void, reject!: (cause: unknown) => void;
          producerStop = new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
          });
          void (async () => {
            if (stream) {
              if (!streamRetirement.returnStream)
                throw new Error('Original widget stream retirement unavailable');
              await streamRetirement.returnStream();
            }
            if (acquired) releaseWidgetLock(sessionId, clientId);
            holder.close();
            owner.widgetProducerClosed = true;
          })().then(resolve, reject);
          return producerStop;
        };
        acquired = acquireWidgetLock(sessionId, clientId, holder);
        if (!acquired) throw new Error('Original widget producer busy');
        scenarioStore.setForSession(sessionId, 'long-turn');
        stream = sendTestModeOriginalLockedMessage(
          runtime,
          sessionId,
          'Owned native widget state patch',
          { cwd: vault.root },
          holder,
          sessionId
        );
        if (!stream) throw new Error('Original widget stream unavailable');
        streamRetirement.returnStream = stream.return.bind(stream, undefined);
        const first = await stream.next();
        if (first.done || first.value.type !== 'session_status')
          throw new Error('Original widget stream did not open');
        const resolved = await resolveTestModeOriginalNativeStreamPrincipal(runtime, stream);
        if (resolved.status !== 'resolved')
          throw new Error('Original widget principal refused', { cause: resolved.status });
        const request = {
          documentId: owner.widgetDocumentId,
          eventId: randomUUID(),
          expectedStateRev: next ? 1 : 0,
          operations: [
            {
              op: 'set',
              path: '/message',
              value: next ? 'Native state after reconnect' : 'Native state arrived',
            },
          ],
        };
        const context: NonNullable<Parameters<typeof invokeCapabilityAsMcpResult>[3]> = {
          serverPrincipal: resolved.principal,
          sessionId,
          cwd: vault.root,
          mcpServer: 'in-session',
        };
        const result = await invokeCapabilityAsMcpResult(
          widgetRegistry,
          'ui.patch_canvas_state',
          request,
          context
        );
        if (result.isError)
          throw new Error('Original widget MCP state mutation refused', { cause: result });
        const { CanvasChannelPatchStateReceiptSchema } =
          await import('@dorkos/shared/canvas-channel-schemas');
        const text = result.content.find((item) => item.type === 'text');
        if (!text || text.type !== 'text')
          throw new Error('Original widget state receipt unavailable');
        const receipt = CanvasChannelPatchStateReceiptSchema.parse(JSON.parse(text.text));
        const presenceNativeEvent = db.$client
          .prepare('SELECT * FROM canvas_doc_events WHERE document_id=? AND event_id=?')
          .get(owner.widgetDocumentId, request.eventId);
        if (
          !presenceNativeEvent ||
          typeof presenceNativeEvent !== 'object' ||
          !('event_id' in presenceNativeEvent) ||
          presenceNativeEvent.event_id !== receipt.receipt.id ||
          !('doc_seq' in presenceNativeEvent) ||
          presenceNativeEvent.doc_seq !== receipt.receipt.docSeq ||
          !('type' in presenceNativeEvent) ||
          presenceNativeEvent.type !== 'state.changed'
        )
          throw new Error('Original widget receipt native row unavailable');
        widgetPresenceNativeEvents.set(request.eventId, JSON.stringify(presenceNativeEvent));
        const duplicate = await invokeCapabilityAsMcpResult(
          widgetRegistry,
          'ui.patch_canvas_state',
          request,
          context
        );
        if (duplicate.isError) throw new Error('Original widget duplicate mutation refused');
        const duplicateText = duplicate.content.find((item) => item.type === 'text');
        if (!duplicateText || duplicateText.type !== 'text')
          throw new Error('Original duplicate state receipt unavailable');
        const duplicateReceipt = CanvasChannelPatchStateReceiptSchema.parse(
          JSON.parse(duplicateText.text)
        );
        if (
          duplicateReceipt.stateRev !== receipt.stateRev ||
          duplicateReceipt.receipt.id !== receipt.receipt.id ||
          duplicateReceipt.receipt.status !== 'duplicate'
        )
          throw new Error('Original duplicate changed widget state identity');
        await owner.stopWidgetProducer();
        if (readTestModeOriginalNativeStream(runtime, stream))
          throw new Error('Original widget stream remained current after drain');
        return { ...receipt, duplicateReceipt };
      })();
      return owner.widgetPatchWork;
    },
    async resetBoundWidgetHistory() {
      if (
        !hostBootstrap ||
        owner.closed ||
        target !== 'session' ||
        !owner.widgetDocumentId ||
        !owner.widgetNextStarted ||
        !owner.widgetProducerClosed ||
        owner.widgetResetStarted
      )
        throw new Error('Original widget retention action unavailable');
      owner.widgetResetStarted = true;
      const { retainDocHistory } =
        await import('../../../../server/src/services/canvas/doc-channel/retention.js');
      // Real byte-pressure policy on this owned store, not forged cursors or event rows.
      retainDocHistory(http.channels, new Date().toISOString(), { documentBytes: 1 });
      const replay = await replayServiceCurrentDoc(http.service, owner.widgetDocumentId, actor, 1);
      if (!replay.resetRequired || replay.stateRev !== 2)
        throw new Error('Original widget reset floor was not observed');
      return {
        stateRev: replay.stateRev,
        retentionFloor: replay.retentionFloor,
        resetRequired: replay.resetRequired,
      };
    },
    async revokeBoundWidgetGrant() {
      if (
        !hostBootstrap ||
        owner.closed ||
        target !== 'session' ||
        !owner.widgetDocumentId ||
        !owner.widgetGrantId ||
        owner.widgetRevokeStarted ||
        !owner.widgetProducerClosed
      )
        throw new Error('Original widget revocation unavailable');
      owner.widgetRevokeStarted = true;
      http.grants.revoke(owner.widgetDocumentId, owner.widgetGrantId, actor);
      const replay = await replayServiceCurrentDoc(http.service, owner.widgetDocumentId, actor);
      const routing = replay.routing;
      if (!routing) throw new Error('Original revoked widget routing unavailable');
      if (routing.enabled) throw new Error('Original revoked widget route remained enabled');
      return { stateRev: replay.stateRev, enabled: routing.enabled };
    },
    /** Fixed private bootstrap; no HTTP issuer, caller scopes or principal registrar. */
    async issueStandaloneToken() {
      if (!hostBootstrap || target !== 'room' || owner.closed || owner.standaloneIssued || !granted)
        throw new Error('Original standalone bootstrap unavailable');
      owner.standaloneIssued = true;
      const { issueServiceOriginalDocToken } =
        await import('../../../../server/src/services/canvas/doc-channel/service.js');
      const issued = await issueServiceOriginalDocToken(
        http.service,
        actor,
        {
          documentId,
          allowedTypes: ['task.comment', 'app.ack', 'agent.reply'],
          directions: ['upstream', 'downstream'],
          permissions: ['ingest', 'replay', 'stream'],
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
        [granted.grant.grantId]
      );
      return issued.token;
    },
  };
}
