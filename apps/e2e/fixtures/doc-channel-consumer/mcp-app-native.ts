/** Fixed session-owned MCP App fixture; App admission and downstream producer are distinct owners. */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canvasDocuments, canvasDocChannels, eq, type Db } from '@dorkos/db';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import type { CapabilityInvocationContext } from '../../../server/src/services/core/capabilities/registry.js';
import { IngestReceiptSchema } from '@dorkos/shared/canvas-channel-schemas';
import { noopLogger } from '@dorkos/shared/logger';
import type { createRoomSubsystem } from '../../../server/src/services/rooms/index.js';
import type { createDocChannelHttpComposition } from '../../../server/src/services/canvas/doc-channel/http-composition.js';
import type { ApprovalService } from '../../../server/src/services/core/approvals/approval-service.js';
import type { DocChannelActor } from '../../../server/src/services/canvas/doc-channel/authorization.js';
import { replayServiceCurrentDoc } from '../../../server/src/services/canvas/doc-channel/service.js';
import { SESSION_AGENT_AUTHOR } from '../../../server/src/services/canvas/scopes.js';
import { composeRegistry } from '../../../server/src/services/core/capabilities/registry.js';
import { invokeCapabilityAsMcpResult } from '../../../server/src/services/core/capabilities/mcp-projection.js';
import { createDocChannelDownstreamCapabilities } from '../../../server/src/services/canvas/doc-channel/downstream/capabilities.js';
import { DetachedTurnLifecycle } from '../../../server/src/services/session/trigger-turn.js';
import { getOrCreateProjector } from '../../../server/src/services/session/session-state-projector.js';
import { scenarioStore } from '../../../server/src/services/runtimes/test-mode/scenario-store.js';
import {
  TestModeRuntime,
  sendTestModeOriginalLockedMessage,
  resolveTestModeOriginalNativeStreamPrincipal,
  readTestModeOriginalNativeStream,
  readTestModeOriginalScenarioCounts,
} from '../../../server/src/services/runtimes/test-mode/test-mode-runtime.js';

/** Build only from the original host's actual admitted native dependencies. */
export function createOriginalMcpAppFixture(own: {
  db: Db;
  http: ReturnType<typeof createDocChannelHttpComposition>;
  rooms: ReturnType<typeof createRoomSubsystem>;
  runtime: TestModeRuntime;
  actor: DocChannelActor;
  approvals: ApprovalService;
  root: string;
  sessionId: string;
  agentId: string;
}) {
  let retired = false,
    documentId: string | undefined,
    emitted = false;
  let setup: Promise<{ documentId: string; generation: string }> | undefined;
  let work: Promise<unknown> | undefined, stop: Promise<void> | undefined;
  let stopProducer: (() => Promise<void>) | undefined;
  let producerStarts = 0;
  const registry = composeRegistry(
    [{ name: 'ui', capabilities: createDocChannelDownstreamCapabilities(own.http.downstream) }],
    { logger: noopLogger }
  );
  const resource = fileURLToPath(new URL('./mcp-app-resource.mjs', import.meta.url));
  const connection = { transport: 'stdio' as const, command: process.execPath, args: [resource] };
  const isLocked = own.runtime.isLocked.bind(own.runtime);
  const acquire = own.runtime.acquireLock.bind(own.runtime);
  const release = own.runtime.releaseLock.bind(own.runtime);
  const interrupt = own.runtime.interruptQuery.bind(own.runtime);
  const read = () => {
    if (retired || !documentId) throw new Error('Original MCP App fixture retired');
    const events = z
      .array(
        z
          .object({
            eventId: z.string().uuid(),
            type: z.enum(['task.changed', 'app.ack', 'app.reply', 'state.changed']),
            direction: z.enum(['upstream', 'downstream']),
            payload: z.string(),
          })
          .strict()
      )
      .parse(
        own.db.$client
          .prepare(
            `SELECT event_id AS eventId, type, direction, payload
      FROM canvas_doc_events WHERE document_id=? AND direction IN ('upstream','downstream') AND type != 'host.focus' ORDER BY doc_seq LIMIT 8`
          )
          .all(documentId)
      );
    const deliveries = z
      .array(
        z
          .object({
            eventId: z.string().uuid(),
            batchId: z.string().nullable(),
            routeId: z.string(),
            status: z.string(),
            ackOutcome: z.enum(['handled', 'rejected']).nullable(),
          })
          .strict()
      )
      .parse(
        own.db.$client
          .prepare(
            `SELECT d.event_id AS eventId, d.batch_id AS batchId, d.route_id AS routeId, d.status, d.ack_outcome AS ackOutcome
      FROM canvas_doc_deliveries AS d JOIN canvas_doc_events AS e ON e.document_id=d.document_id AND e.event_id=d.event_id
      WHERE d.document_id=? ORDER BY e.doc_seq LIMIT 4`
          )
          .all(documentId)
      );
    const admissions = z
      .array(
        z
          .object({
            id: z.string(),
            state: z.string(),
            batchId: z.string(),
            sourceId: z.string(),
            sourceGeneration: z.string(),
            batchGeneration: z.string(),
            turnStartSeq: z.number().int().nullable(),
          })
          .strict()
      )
      .parse(
        own.db.$client
          .prepare(
            `SELECT receipt.id, receipt.state, batch.batch_id AS batchId, receipt.source_id AS sourceId, receipt.source_generation AS sourceGeneration, batch.generation AS batchGeneration, receipt.turn_start_seq AS turnStartSeq
      FROM session_message_acceptance_receipts AS receipt JOIN canvas_doc_batches AS batch ON batch.admission_receipt_id=receipt.id
      WHERE batch.document_id=? LIMIT 3`
          )
          .all(documentId)
      );
    const batches = z
      .array(
        z
          .object({
            batchId: z.string(),
            generation: z.string(),
            dueAt: z.string(),
            status: z.string(),
            inputEventIds: z
              .string()
              .transform((value) => z.array(z.string().uuid()).parse(JSON.parse(value))),
          })
          .strict()
      )
      .parse(
        own.db.$client
          .prepare(
            `SELECT batch_id AS batchId,generation,due_at AS dueAt,status,input_event_ids AS inputEventIds FROM canvas_doc_batches WHERE document_id=? LIMIT 3`
          )
          .all(documentId)
      );
    const counts = readTestModeOriginalScenarioCounts(own.runtime);
    if (
      !counts ||
      events.length > 6 ||
      deliveries.length > 2 ||
      admissions.length > 1 ||
      batches.length > 1
    )
      throw new Error('Original MCP App census differs');
    return {
      documentId,
      events,
      deliveries,
      admissions,
      batches,
      scenarioStarts: counts.scenarioStarts,
      downstreamProducerStarts: producerStarts,
      targetLocked: isLocked(own.sessionId),
    };
  };
  return {
    open() {
      if (retired || setup || documentId) throw new Error('Original MCP App already opened');
      setup = (async () => {
        // This ordinary boot configuration feeds BOTH membership and actual resource resolution.
        own.runtime.setManagedMcpServers({
          injectableServersForCwd: (cwd): Record<string, McpAppServerConnection> =>
            cwd === own.root ? { 'original-document-app': connection } : {},
        });
        getOrCreateProjector(own.sessionId, own.root);
        documentId = own.rooms.canvas.open(
          'session:' + own.sessionId,
          SESSION_AGENT_AUTHOR,
          {
            type: 'mcp_app',
            serverName: 'original-document-app',
            uri: 'ui://original-document-app/main',
            title: 'Original document MCP App',
          },
          {
            tree: {
              resolvedCwd: own.root,
              treeKind: 'agent-cwd',
              sourceLabel: null,
              aheadOfMain: null,
            },
          }
        ).id;
        own.http.grants.configure(
          documentId,
          {
            routes: [
              {
                id: 'mcp-app',
                on: 'task.*',
                to: 'agent:owner',
                turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 2 },
              },
            ],
          },
          own.actor,
          own.agentId
        );
        const request = {
          documentId,
          routeId: 'mcp-app',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
        let granted = own.http.grants.grant(request, own.actor);
        if (granted.kind === 'approval_required') {
          own.approvals.grant(granted.ticket.approvalId);
          granted = own.http.grants.grant(request, own.actor, granted.ticket.token);
        }
        if (granted.kind !== 'granted') throw new Error('Original MCP App grant unavailable');
        const current = await replayServiceCurrentDoc(own.http.service, documentId, own.actor);
        if (retired || !current.incarnation) throw new Error('Original MCP App birth unavailable');
        // Diagnostic prerequisite only: the same original replay must disclose its
        // genuine stored source before a browser can negotiate this document.
        const origin = current.mcpOrigin;
        if (!origin) throw new Error('Original MCP stored origin absent');
        const stored = own.db
          .select({
            scope: canvasDocChannels.scope,
            declarationHash: canvasDocChannels.declarationHash,
            physicalRevision: canvasDocuments.rev,
          })
          .from(canvasDocChannels)
          .innerJoin(canvasDocuments, eq(canvasDocuments.id, canvasDocChannels.documentId))
          .where(eq(canvasDocChannels.documentId, documentId))
          .get();
        if (
          retired ||
          !stored ||
          stored.scope !== 'session:' + own.sessionId ||
          origin.canonicalSessionId !== own.sessionId ||
          origin.serverName !== 'original-document-app' ||
          origin.uri !== 'ui://original-document-app/main' ||
          origin.declarationHash !== stored.declarationHash ||
          origin.physicalRevision !== stored.physicalRevision
        )
          throw new Error('Original MCP origin differs from native stored source');

        return { documentId, generation: current.incarnation.generation };
      })();
      return setup;
    },
    documentId() {
      if (retired || !documentId) throw new Error('Original MCP App unavailable');
      return documentId;
    },
    read,
    emitDownstream() {
      if (retired || !documentId || emitted || isLocked(own.sessionId))
        throw new Error('Original MCP App producer unavailable');
      emitted = true;
      work = (async () => {
        const current = read();
        if (current.deliveries.length !== 2 || current.admissions.length !== 1)
          throw new Error('Original App admission required before downstream producer');
        const delivery = current.deliveries[0],
          remaining = current.deliveries[1];
        if (
          !remaining ||
          remaining.batchId !== delivery?.batchId ||
          remaining.routeId !== 'mcp-app' ||
          remaining.eventId === delivery?.eventId
        )
          throw new Error('Original MCP partial batch differs');
        if (
          !delivery ||
          typeof delivery !== 'object' ||
          !('eventId' in delivery) ||
          typeof delivery.eventId !== 'string' ||
          !('batchId' in delivery) ||
          typeof delivery.batchId !== 'string' ||
          !('routeId' in delivery) ||
          delivery.routeId !== 'mcp-app'
        )
          throw new Error('Original App delivery tuple unavailable');
        const holder = new DetachedTurnLifecycle();
        const clientId = 'original-mcp-downstream';
        const captured: {
          stream?: ReturnType<typeof sendTestModeOriginalLockedMessage>;
          originalReturn?: () => Promise<unknown>;
        } = {};
        let acquired = false,
          producerStop: Promise<void> | undefined;
        stopProducer = () =>
          (producerStop ??= (async () => {
            let failure: { cause: unknown } | undefined;
            const attempt = async (action: () => unknown) => {
              try {
                await action();
              } catch (cause) {
                failure ??= { cause };
              }
            };
            const interrupted = attempt(() => interrupt(own.sessionId));
            const returned = attempt(() => captured.originalReturn?.());
            await Promise.all([interrupted, returned]);
            await attempt(() => {
              if (acquired) release(own.sessionId, clientId);
            });
            await attempt(() => holder.close());
            await attempt(() => scenarioStore.clearSession(own.sessionId));
            if (captured.stream && readTestModeOriginalNativeStream(own.runtime, captured.stream))
              failure ??= { cause: new Error('Original MCP stream closure unknown') };
            if (failure) throw failure.cause;
          })());
        acquired = acquire(own.sessionId, clientId, holder);
        if (!acquired) throw new Error('Original MCP producer busy');
        scenarioStore.setForSession(own.sessionId, 'long-turn');
        const stream = sendTestModeOriginalLockedMessage(
          own.runtime,
          own.sessionId,
          'Original MCP downstream producer',
          { cwd: own.root },
          holder,
          own.sessionId
        );
        captured.stream = stream;
        if (!stream) throw new Error('Original MCP stream unavailable');
        const originalReturn = stream.return.bind(stream, undefined);
        captured.originalReturn = originalReturn;
        const first = await stream.next();
        if (first.done || first.value.type !== 'session_status')
          throw new Error('Original MCP stream did not open');
        if (retired) throw new Error('Original MCP producer retired during open');
        producerStarts++;
        const resolved = await resolveTestModeOriginalNativeStreamPrincipal(own.runtime, stream);
        if (retired) throw new Error('Original MCP producer retired during resolution');
        if (resolved.status !== 'resolved')
          throw new Error('Original MCP stream principal refused');
        const context: CapabilityInvocationContext = {
          serverPrincipal: resolved.principal,
          sessionId: own.sessionId,
          cwd: own.root,
          mcpServer: 'in-session',
        };
        const ack = {
          documentId,
          eventId: randomUUID(),
          type: 'app.ack',
          payload: {
            batchId: delivery.batchId,
            routeId: delivery.routeId,
            eventIds: [delivery.eventId],
            outcome: 'handled',
          },
        };
        const reply = {
          documentId,
          eventId: randomUUID(),
          type: 'app.reply',
          payload: { message: 'Original MCP reply', eventIds: [remaining.eventId] },
        };
        const send = async (request: typeof ack | typeof reply) => {
          if (retired) throw new Error('Original MCP producer retired before send');
          const result = await invokeCapabilityAsMcpResult(
            registry,
            'ui.send_canvas_event',
            request,
            context
          );
          if (result.isError) throw new Error('Original MCP downstream refused', { cause: result });
          const body = result.content.find((item) => item.type === 'text');
          if (!body || body.type !== 'text')
            throw new Error('Original MCP downstream receipt absent');
          const receipt = IngestReceiptSchema.parse(JSON.parse(body.text).receipt);
          if (receipt.id !== request.eventId)
            throw new Error('Original MCP downstream receipt mismatch');
          return receipt;
        };
        const ackReceipt = await send(ack),
          replyReceipt = await send(reply);
        const stateRequest = {
          documentId,
          eventId: randomUUID(),
          expectedStateRev: 0,
          operations: [
            { op: 'set', path: '/message', value: 'Original MCP state arrived' },
            { op: 'set', path: '/largeA', value: 'x'.repeat(12 * 1024) },
          ],
        };
        if (retired) throw new Error('Original MCP producer retired before state');
        const patch = await invokeCapabilityAsMcpResult(
          registry,
          'ui.patch_canvas_state',
          stateRequest,
          context
        );
        if (patch.isError) throw new Error('Original MCP state refused', { cause: patch });
        const patchText = patch.content.find((item) => item.type === 'text');
        if (!patchText || patchText.type !== 'text')
          throw new Error('Original MCP state receipt unavailable');
        const { CanvasChannelPatchStateReceiptSchema } =
          await import('@dorkos/shared/canvas-channel-schemas');
        const state = CanvasChannelPatchStateReceiptSchema.parse(JSON.parse(patchText.text));
        if (state.receipt.id !== stateRequest.eventId || state.stateRev !== 1)
          throw new Error('Original MCP state receipt differs');
        const secondStateRequest = {
          documentId,
          eventId: randomUUID(),
          expectedStateRev: 1,
          operations: [{ op: 'set', path: '/largeB', value: 'y'.repeat(12 * 1024) }],
        };
        if (retired) throw new Error('Original MCP producer retired before second state');
        const secondPatch = await invokeCapabilityAsMcpResult(
          registry,
          'ui.patch_canvas_state',
          secondStateRequest,
          context
        );
        if (secondPatch.isError)
          throw new Error('Original MCP second state refused', { cause: secondPatch });
        const secondText = secondPatch.content.find((item) => item.type === 'text');
        if (!secondText || secondText.type !== 'text')
          throw new Error('Original MCP second state receipt unavailable');
        const secondState = CanvasChannelPatchStateReceiptSchema.parse(JSON.parse(secondText.text));
        if (secondState.receipt.id !== secondStateRequest.eventId || secondState.stateRev !== 2)
          throw new Error('Original MCP second state differs');
        if (retired) throw new Error('Original MCP producer retired before state retry');
        const duplicate = await invokeCapabilityAsMcpResult(
          registry,
          'ui.patch_canvas_state',
          secondStateRequest,
          context
        );
        if (duplicate.isError)
          throw new Error('Original MCP state retry refused', { cause: duplicate });
        const duplicateText = duplicate.content.find((item) => item.type === 'text');
        if (!duplicateText || duplicateText.type !== 'text')
          throw new Error('Original MCP state retry receipt unavailable');
        const duplicateState = CanvasChannelPatchStateReceiptSchema.parse(
          JSON.parse(duplicateText.text)
        );
        if (
          duplicateState.receipt.id !== secondState.receipt.id ||
          duplicateState.stateRev !== 2 ||
          duplicateState.receipt.status !== 'duplicate'
        )
          throw new Error('Original MCP state retry duplicated mutation');
        await stopProducer();
        return {
          stateRev: secondState.stateRev,
          stateEventId: secondState.receipt.id,

          ackEventId: ackReceipt.id,
          replyEventId: replyReceipt.id,
          downstreamProducerStarts: producerStarts,
        };
      })();
      return work;
    },
    close() {
      if (stop) return stop;
      retired = true;
      stop = (async () => {
        let failure: { cause: unknown } | undefined;
        const attempt = async (action: () => unknown) => {
          try {
            await action();
          } catch (cause) {
            failure ??= { cause };
          }
        };
        const firstStop = stopProducer;
        if (firstStop) await attempt(firstStop);
        if (setup) await attempt(() => setup);
        if (work) await attempt(() => work);
        if (stopProducer && stopProducer !== firstStop) await attempt(stopProducer);
        if (failure) throw failure.cause;
      })();
      return stop;
    },
  };
}
