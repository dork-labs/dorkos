/** Fixed fixture work, expired by the original pump policy rather than direct status mutation. */
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import {
  and,
  eq,
  canvasDocBatches,
  canvasDocDeliveries,
  canvasDocEvents,
  canvasDocGrants,
  sessionMessageAcceptanceReceipts,
  type Db,
} from '@dorkos/db';
import { CanvasChannelRouteSchema } from '@dorkos/shared/canvas-channel-schemas';
import { SESSION_AGENT_AUTHOR } from '../../../server/src/services/canvas/scopes.js';
import type { createRoomSubsystem } from '../../../server/src/services/rooms/index.js';
import type { createDocChannelHttpComposition } from '../../../server/src/services/canvas/doc-channel/http-composition.js';
import type { DocChannelActor } from '../../../server/src/services/canvas/doc-channel/authorization.js';
import {
  replayServiceCurrentDoc,
  submitCurrentDocEvent,
} from '../../../server/src/services/canvas/doc-channel/service.js';
import { DocBatchDeliveryPump } from '../../../server/src/services/canvas/doc-channel/delivery/pump.js';
import { createPrivateDocPumpGates } from '../../../server/src/services/canvas/doc-channel/delivery/private-gates.js';
import type { DocBatchAdmission } from '../../../server/src/services/canvas/doc-channel/delivery/batch-admission.js';
import type { RuntimeRegistry } from '../../../server/src/services/core/runtime-registry.js';
import {
  readTestModeOriginalScenarioCounts,
  type TestModeRuntime,
} from '../../../server/src/services/runtimes/test-mode/test-mode-runtime.js';
import {
  setMessageQueueStore,
  type MessageQueueStore,
} from '../../../server/src/services/session/message-queue-store.js';
import { setPrivateSessionMessageAcceptanceService } from '../../../server/src/services/session/private-messages/acceptance.js';
import {
  adoptAcceptedPrivateMessages,
  suspendPrivateDispatches,
} from '../../../server/src/services/session/message-dispatcher.js';
import { getOrCreateProjector } from '../../../server/src/services/session/session-state-projector.js';

const NativeDate = Date;
const baseline = 'Original retained context for explicit operator review.\n';

/** Receives only the actual isolated constructor's already-owned services; never issues a principal or source token. */
export function createOriginalReviewedReplayControl(options: {
  db: Db;
  rooms: ReturnType<typeof createRoomSubsystem>;
  http: ReturnType<typeof createDocChannelHttpComposition>;
  actor: DocChannelActor;
  root: string;
  scope: string;
  sessionId: string;
  agentId: string;
  admission: DocBatchAdmission;
  queue: MessageQueueStore;
  runtime: TestModeRuntime;
  runtimes: RuntimeRegistry;
}) {
  const { db, http, admission, runtime } = options;
  const lifetime = new AbortController();
  let retired = false,
    opened = false,
    expirationStarted = false,
    dispatchStarted = false;
  let closed = false,
    documentId: string | undefined,
    inputId: string | undefined;
  let inputOriginal: typeof canvasDocEvents.$inferSelect | undefined;
  let oldBatch: typeof canvasDocBatches.$inferSelect | undefined;
  let openWork: Promise<unknown> | undefined, expireWork: Promise<unknown> | undefined;
  let dispatchWork: Promise<unknown> | undefined, retirement: Promise<void> | undefined;
  const path = join(options.root, 'native-reviewed-replay.md');
  const requireLive = () => {
    if (retired || db.$client.inTransaction)
      throw new Error('Original reviewed replay fixture retired');
  };
  const startDispatch = () => {
    setMessageQueueStore(options.queue);
    setPrivateSessionMessageAcceptanceService(admission.acceptance);
    return adoptAcceptedPrivateMessages({
      sessionId: options.sessionId,
      runtime,
      cwd: options.root,
      projector: getOrCreateProjector(options.sessionId),
      privateDispatchSignal: lifetime.signal,
    });
  };
  const read = async () => {
    requireLive();
    if (!documentId) throw new Error('Original reviewed replay document unavailable');
    const bytes = await readFile(path);
    requireLive();
    const events = db
      .select()
      .from(canvasDocEvents)
      .where(
        and(eq(canvasDocEvents.documentId, documentId), eq(canvasDocEvents.type, 'task.changed'))
      )
      .limit(2)
      .all();
    const batches = db
      .select()
      .from(canvasDocBatches)
      .where(eq(canvasDocBatches.documentId, documentId))
      .limit(3)
      .all();
    const deliveries = db
      .select()
      .from(canvasDocDeliveries)
      .where(eq(canvasDocDeliveries.documentId, documentId))
      .limit(2)
      .all();
    const receipts = db
      .select({
        id: sessionMessageAcceptanceReceipts.id,
        state: sessionMessageAcceptanceReceipts.state,
        sourceId: sessionMessageAcceptanceReceipts.sourceId,
        sourceGeneration: sessionMessageAcceptanceReceipts.sourceGeneration,
        turnStartSeq: sessionMessageAcceptanceReceipts.turnStartSeq,
      })
      .from(sessionMessageAcceptanceReceipts)
      .innerJoin(
        canvasDocBatches,
        eq(canvasDocBatches.admissionReceiptId, sessionMessageAcceptanceReceipts.id)
      )
      .where(eq(canvasDocBatches.documentId, documentId))
      .limit(2)
      .all();
    const counts = readTestModeOriginalScenarioCounts(runtime);
    if (
      !counts ||
      events.length > 1 ||
      batches.length > 2 ||
      deliveries.length > 1 ||
      receipts.length > 1
    )
      throw new Error('Original reviewed replay census bound');
    if (inputOriginal && JSON.stringify(events[0]) !== JSON.stringify(inputOriginal))
      throw new Error('Original reviewed input changed');
    return {
      documentId,
      baselineUnchanged:
        createHash('sha256').update(bytes).digest('hex') ===
        createHash('sha256').update(baseline).digest('hex'),
      inputId: inputId ?? null,
      oldBatchId: oldBatch?.batchId ?? null,
      events,
      batches,
      deliveries,
      receipts,
      scenarioStarts: counts.scenarioStarts,
    };
  };
  return {
    open() {
      requireLive();
      if (opened || !options.scope.startsWith('session:'))
        throw new Error('Original reviewed replay setup unavailable');
      opened = true;
      openWork = (async () => {
        await writeFile(path, baseline);
        requireLive();
        documentId = options.rooms.canvas.open(
          options.scope,
          SESSION_AGENT_AUTHOR,
          { type: 'file', sourcePath: path, language: 'markdown', title: 'Native reviewed source' },
          {
            tree: {
              resolvedCwd: options.root,
              treeKind: 'agent-cwd',
              sourceLabel: null,
              aheadOfMain: null,
            },
          }
        ).id;
        http.grants.configure(
          documentId,
          {
            routes: [
              {
                id: 'native-reviewed',
                on: 'task.changed',
                to: 'agent:owner',
                turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 2 },
              },
            ],
          },
          options.actor,
          options.agentId
        );
        return { documentId };
      })();
      return openWork;
    },
    expire() {
      requireLive();
      if (!documentId || expirationStarted || runtime.isLocked(options.sessionId))
        throw new Error('Original reviewed replay expiry unavailable');
      expirationStarted = true;
      expireWork = (async () => {
        const replay = await replayServiceCurrentDoc(http.service, documentId!, options.actor);
        requireLive();
        if (
          !replay.incarnation ||
          replay.incarnation.documentId !== documentId ||
          replay.scope !== options.scope
        )
          throw new Error('Original reviewed replay birth unavailable');
        inputId = randomUUID();
        const receipt = await submitCurrentDocEvent(
          http.service,
          documentId!,
          {
            v: 1,
            id: inputId,
            type: 'task.changed',
            payload: { text: 'Original retained context' },
          },
          options.actor,
          { expectedGeneration: replay.incarnation.generation }
        );
        requireLive();
        if (receipt.receipt.id !== inputId || receipt.receipt.status !== 'recorded')
          throw new Error('Original reviewed input receipt differs');
        const rows = db
          .select()
          .from(canvasDocBatches)
          .where(eq(canvasDocBatches.documentId, documentId!))
          .limit(2)
          .all();
        if (
          rows.length !== 1 ||
          rows[0].status !== 'pending' ||
          rows[0].inputEventIds.length !== 1 ||
          rows[0].inputEventIds[0] !== inputId
        )
          throw new Error('Original reviewed pending input unavailable');
        oldBatch = rows[0];
        inputOriginal = db
          .select()
          .from(canvasDocEvents)
          .where(
            and(eq(canvasDocEvents.documentId, documentId!), eq(canvasDocEvents.eventId, inputId))
          )
          .get();
        if (!inputOriginal) throw new Error('Original reviewed input unavailable');
        // This fixture owns a new original pump. Its existing constructor clock
        // is fixed once from the actual firstAt plus the production 24-hour policy.
        // The browser supplies neither a timestamp nor batch/status mutation.
        const grant = db
          .select()
          .from(canvasDocGrants)
          .where(eq(canvasDocGrants.grantId, oldBatch.grantId))
          .get();
        if (!grant || grant.documentId !== documentId || grant.routeId !== 'native-reviewed')
          throw new Error('Original reviewed grant unavailable');
        const route = CanvasChannelRouteSchema.parse(grant.normalizedRoute);
        if (
          route.id !== 'native-reviewed' ||
          route.on !== 'task.changed' ||
          route.to !== 'agent:owner' ||
          route.turn.mode !== 'coalesce' ||
          route.turn.windowMs !== 1000 ||
          route.turn.maxBatch !== 2
        )
          throw new Error('Original reviewed route changed');
        const firstAt = NativeDate.parse(oldBatch.dueAt) - route.turn.windowMs;
        if (!Number.isFinite(firstAt)) throw new Error('Original reviewed firstAt invalid');
        const expiryAt = firstAt + 24 * 3600_000;
        const now = () => new NativeDate(expiryAt);
        const beforeExpiry = await read();
        if (
          beforeExpiry.receipts.length !== 0 ||
          beforeExpiry.scenarioStarts !== 0 ||
          beforeExpiry.batches[0]?.status !== 'pending'
        )
          throw new Error('Original reviewed work already admitted');
        requireLive();
        const pump = new DocBatchDeliveryPump({
          db,
          store: http.channels,
          grants: http.grants,
          admission,
          now,
          ...createPrivateDocPumpGates({ grants: http.grants, runtimes: options.runtimes, now }),
          markWaitingWarning: (batchId, generation, at, tx) =>
            http.channels.markWaitingWarning(batchId, generation, at, tx),
          nudge: () => {
            dispatchStarted = true;
            startDispatch();
            return undefined;
          },
        });
        const result = pump.run();
        const current = await read();
        if (
          result.expired !== 1 ||
          result.admitted !== 0 ||
          result.waiting !== 0 ||
          result.cancelled !== 0 ||
          current.batches[0]?.status !== 'expired' ||
          current.deliveries[0]?.status !== 'expired' ||
          current.receipts.length !== 0 ||
          current.scenarioStarts !== 0
        )
          throw new Error('Original pump did not expire only unadmitted work');
        return current;
      })();
      return expireWork;
    },
    async pump() {
      requireLive();
      if (!documentId || !oldBatch || dispatchStarted || runtime.isLocked(options.sessionId))
        throw new Error('Original reviewed replay dispatch unavailable');
      const current = await read();
      requireLive();
      const next = current.batches.find((row) => row.batchId !== oldBatch!.batchId);
      if (
        current.batches.length !== 2 ||
        !next ||
        next.status !== 'pending' ||
        next.inputEventIds.length !== 1 ||
        next.inputEventIds[0] !== inputId ||
        current.batches.find((row) => row.batchId === oldBatch!.batchId)?.errorCode !==
          'manual_replay_consumed' ||
        current.receipts.length !== 0
      )
        throw new Error('Original single reviewed generation unavailable');
      dispatchStarted = true;
      dispatchWork = (async () => {
        admission.admit(next.batchId);
        startDispatch();
        requireLive();
        return read();
      })();
      return dispatchWork;
    },
    read,
    stop() {
      if (retirement) return retirement;
      retired = true;
      retirement = (async () => {
        let failed = false,
          first: unknown;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            first = cause;
          }
        };
        try {
          lifetime.abort();
        } catch (cause) {
          remember(cause);
        }
        const suspension = dispatchStarted
          ? suspendPrivateDispatches(lifetime.signal).catch(remember)
          : Promise.resolve();
        for (const work of [openWork, expireWork, dispatchWork]) {
          try {
            await work;
          } catch (cause) {
            remember(cause);
          }
        }
        await suspension;
        if (failed) throw first;
        closed = true;
      })();
      return retirement;
    },
    isClosed: () => closed,
  };
}
