/** Canonical continuity from the actual held native producer, then a fresh same-FILE Room boot. */
import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql, sessionMetadata, eq } from '@dorkos/db';
import {
  nativeRoomAuthorityFixture,
  reopenNativeRoomAuthorityFixture,
} from '../writes/__tests__/authority-fixtures.js';
import { toggleOriginalCheckboxWriter } from '../writes/checkbox-service.js';
import { stopInstallationFileWrites } from '../writes/installation-file-writes.js';
import { currentRoomDueServicePort, prepareServiceOriginalRoomResponder } from '../service.js';
import { RuntimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import {
  TestModeRuntime,
  captureTestModeOriginalRoomEmitter,
  sendTestModeOriginalLockedMessage,
  readTestModeOriginalCanonicalSessionId,
  moveTestModeOriginalLockedAcquisition,
  readTestModeOriginalNativeStream,
  resolveTestModeOriginalNativeStreamPrincipal,
  readTestModeOriginalScenarioCounts,
  readTestModeOriginalScenarioEvidence,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import { DetachedTurnLifecycle } from '../../../session/trigger-turn.js';
import { createCanonicalRekey } from '../../../session/turn-identity/canonical-rekey.js';
import {
  getOrCreateProjector,
  rekeyProjector,
  disposeProjector,
} from '../../../session/session-state-projector.js';
import { followSessionRekeys } from '../../../rooms/session-bindings/room-session-convergence.js';
import { env as serverEnv } from '../../../../env.js';

it('preserves original FILE input/receipt and unclaimed batch identity through native canonical rekey and same-FILE restart; starts exactly one Room turn', async () => {
  const agentPath = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'native-canonical-recovery-'))
  );
  const sessionId = randomUUID(),
    agentId = randomUUID(),
    oldMode = serverEnv.DORKOS_TEST_RUNTIME;
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let reopened: Awaited<ReturnType<typeof reopenNativeRoomAuthorityFixture>> | undefined;
  let runtime: TestModeRuntime | undefined;
  let stream: AsyncGenerator<import('@dorkos/shared/types').StreamEvent> | undefined;
  let originalReturn: (() => Promise<unknown>) | undefined;
  let interrupt: (() => Promise<unknown>) | undefined;
  let stopFollowing: (() => void) | undefined;
  let restorePublicId: (() => void) | undefined;
  let canonicalId: string | undefined,
    key: string = sessionId;
  const clientId = 'original-canonical-control',
    holder = new DetachedTurnLifecycle(),
    token = Symbol(clientId);
  let failed = false,
    first: unknown,
    producerClosed = false,
    ownersClosed = false;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    serverEnv.DORKOS_TEST_RUNTIME = true;
    h = await nativeRoomAuthorityFixture(agentPath, 'claude-code', sessionId, agentId, {
      checkboxFile: true,
      coalesceWindowMs: 100,
    });
    const actual = h;
    runtime = new TestModeRuntime('claude-code', actual.principals);
    captureTestModeOriginalRoomEmitter(
      runtime,
      actual.http.fileWrites,
      actual.db,
      actual.http.channels
    );
    const raw = runtime,
      registry = new RuntimeRegistry();
    registry.setDb(actual.db);
    registry.register(raw);
    const selected = registry.get('claude-code');
    expect(readOriginalRegisteredRuntime(selected)).toBe(raw);
    // Original physical session document causes the genuine canvas lifecycle to retain its applied intent.
    const anchor = actual.rooms.canvas.open(
      'session:' + sessionId,
      'agent',
      { type: 'markdown', content: 'Native canonical anchor' },
      {
        tree: {
          resolvedCwd: agentPath,
          treeKind: 'agent-cwd',
          sourceLabel: null,
          aheadOfMain: null,
        },
      }
    );
    stopFollowing = followSessionRekeys(actual.rooms.store);
    getOrCreateProjector(sessionId);
    scenarioStore.setForSession(sessionId, 'native-canonical-rekey');
    // Caller declarations and public adapter overrides cannot supply the original native canonical pointer.
    const forged = randomUUID();
    raw.declareCanonicalSessionId(sessionId, forged);
    const publicId = vi.spyOn(raw, 'getInternalSessionId').mockReturnValue(forged);
    restorePublicId = publicId.mockRestore.bind(publicId);
    expect(raw.acquireLock(sessionId, clientId, holder, token)).toBe(true);
    stream = sendTestModeOriginalLockedMessage(
      selected,
      sessionId,
      'real canonical producer',
      { cwd: agentPath },
      holder,
      sessionId
    );
    if (!stream) throw new Error('Original registered native stream required');
    originalReturn = stream.return.bind(stream, undefined);
    interrupt = raw.interruptQuery.bind(raw, sessionId);
    expect((await stream.next()).value?.type).toBe('session_status');
    expect((await resolveTestModeOriginalNativeStreamPrincipal(selected, stream)).status).toBe(
      'resolved'
    );
    expect(readTestModeOriginalCanonicalSessionId(raw, sessionId)?.canonicalId).toBeUndefined();
    expect(moveTestModeOriginalLockedAcquisition(raw, sessionId, forged, holder)).toBe(false);
    expect((await stream.next()).value).toMatchObject({
      type: 'text_delta',
      data: { text: 'NATIVE_CANONICAL_REKEY_WAITING' },
    });
    const request = await actual.checkboxRequest(true);
    const receipt = await toggleOriginalCheckboxWriter(
      actual.http.checkboxWriter,
      request,
      actual.operator
    );
    expect(receipt.status).toBe('changed');
    const event = actual.http.channels.getEvent(actual.documentId, request.eventId)!;
    const savedIntent = actual.db.get<
      Record<string, unknown>
    >(sql`SELECT * FROM canvas_doc_write_intents
      WHERE document_id=${actual.documentId} AND event_id=${request.eventId}`)!;
    expect(savedIntent).toBeDefined();
    if (typeof savedIntent.evidence !== 'string')
      throw new Error('Original saved checkbox evidence unavailable');
    expect(JSON.parse(savedIntent.evidence).receipt).toEqual(receipt);
    const pending = actual.db.get<{ status: string; dueAt: string }>(
      sql`SELECT status,due_at AS dueAt FROM canvas_doc_batches WHERE document_id=${actual.documentId}`
    )!;
    expect(pending.status).toBe('pending');
    const remaining = Date.parse(pending.dueAt) - Date.now();
    if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    currentRoomDueServicePort(actual.http.service).wake();
    const before = actual.db.get<Record<string, unknown>>(
      sql`SELECT * FROM canvas_doc_batches WHERE document_id=${actual.documentId}`
    )!;
    expect(before.status).toBe('accepted');
    expect(typeof before.room_admission_id).toBe('string');
    expect(before.admission_receipt_id).toBeNull();
    expect(before.turn_id).toBeNull();
    expect(
      actual.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_doc_admissions`)!.n
    ).toBe(0);
    expect(actual.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(0);
    const next = stream.next();
    const observed = next.then(
      (value) => ({ value }),
      (cause) => ({ cause })
    );
    await vi.waitFor(() => expect(interactionGate.step(sessionId)).toBe(true));
    const moved = await observed;
    if ('cause' in moved) throw moved.cause;
    expect(moved.value.value?.type).toBe('session_status');
    canonicalId = readTestModeOriginalCanonicalSessionId(raw, sessionId)?.canonicalId;
    if (!canonicalId) throw new Error('Original producer did not retain its assigned canonical ID');
    expect(canonicalId).not.toBe(forged);
    const rekey = createCanonicalRekey({
      sessionId,
      clientId,
      holder,
      lockToken: token,
      turnKey: () => key,
      onTurnKey: (nextKey) => {
        key = nextKey;
      },
      chain: { link: () => {} },
      deps: {
        getInternalSessionId: (id) => readTestModeOriginalCanonicalSessionId(raw, id)?.canonicalId,
        rekeyProjector,
        acquireLock: raw.acquireLock.bind(raw),
        releaseLock: raw.releaseLock.bind(raw),
        moveNativeLock: (oldId, newId, ownHolder) =>
          moveTestModeOriginalLockedAcquisition(raw, oldId, newId, ownHolder),
      },
    });
    rekey();
    expect(publicId).not.toHaveBeenCalled();
    expect(key).toBe(canonicalId);
    expect(raw.isLocked(sessionId)).toBe(false);
    expect(raw.isLocked(canonicalId)).toBe(true);
    expect(
      actual.db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, sessionId)).get()
    ).toBeUndefined();
    expect(
      actual.db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, canonicalId))
        .get()
    ).toMatchObject({ agentPath, runtime: 'claude-code' });
    expect(actual.rooms.canvasDocuments.get('session:' + canonicalId, anchor.id)).toBeDefined();
    expect(
      actual.db.get<{ status: string }>(
        sql`SELECT status FROM canvas_doc_identity_intents WHERE document_id=${anchor.id}`
      )!.status
    ).toBe('applied');
    expect((await resolveTestModeOriginalNativeStreamPrincipal(selected, stream)).status).toBe(
      'refused'
    );
    expect(actual.http.channels.getEvent(actual.documentId, request.eventId)).toEqual(event);
    expect(
      actual.db.get<Record<string, unknown>>(sql`SELECT * FROM canvas_doc_write_intents
      WHERE document_id=${actual.documentId} AND event_id=${request.eventId}`)
    ).toEqual(savedIntent);
    const retained = actual.db.get<Record<string, unknown>>(
      sql`SELECT * FROM canvas_doc_batches WHERE document_id=${actual.documentId}`
    )!;
    expect(retained.batch_id).toBe(before.batch_id);
    expect(retained.generation).toBe(before.generation);
    expect(retained.room_admission_id).toBe(before.room_admission_id);
    expect(retained.admission_receipt_id).toBeNull();
    expect(retained.turn_id).toBeNull();
    expect(
      actual.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_doc_admissions`)!.n
    ).toBe(0);
    expect(retained.status).toBe('accepted');
    publicId.mockRestore();
    await originalReturn();
    producerClosed = true;
    expect(readTestModeOriginalNativeStream(raw, stream)).toBeUndefined();
    expect(readTestModeOriginalScenarioEvidence(raw, stream)).toMatchObject({
      scenarioStarts: 1,
      retired: true,
    });
    raw.releaseLock(key, clientId, token);
    holder.close();
    let closeFailed = false,
      closeCause: unknown;
    const retainClose = (cause: unknown) => {
      if (!closeFailed) {
        closeFailed = true;
        closeCause = cause;
      }
    };
    await Promise.allSettled([
      Promise.resolve()
        .then(() =>
          stopInstallationFileWrites(actual.http.fileWrites, actual.db, actual.http.channels)
        )
        .catch(retainClose),
      Promise.resolve()
        .then(() => currentRoomDueServicePort(actual.http.service).stopPump())
        .catch(retainClose),
    ]);
    if (closeFailed) throw closeCause;
    ownersClosed = true;
    stopFollowing();
    stopFollowing = undefined;
    actual.db.$client.close();
    reopened = await reopenNativeRoomAuthorityFixture(actual);
    const successor = reopened,
      nextRuntime = new TestModeRuntime('claude-code', successor.principals),
      nextRegistry = new RuntimeRegistry();
    captureTestModeOriginalRoomEmitter(
      nextRuntime,
      successor.http.fileWrites,
      successor.db,
      successor.http.channels
    );
    nextRegistry.setDb(successor.db);
    nextRegistry.register(nextRuntime);
    scenarioStore.setForSession(canonicalId, 'simple-text');
    // The genuine installed due port lazily constructs the original Room owner and
    // reacquires its native accepted capsule. Wake freezes due input; it does not start a turn.
    const port = currentRoomDueServicePort(successor.http.service);
    port.wake();
    // Native acceptance does not permit an invented destination: require original Room
    // retirement lineage and the exact current agent/session binding before acquisition.
    const retirement = successor.db.get<{ canonical_session_id: string; retired_at: number }>(
      sql`SELECT canonical_session_id,retired_at FROM room_session_retirements WHERE retired_session_id=${sessionId}`
    )!;
    expect(retirement.canonical_session_id).toBe(canonicalId);
    const rejectedHolder = new DetachedTurnLifecycle();
    const confirmedCanonicalId = canonicalId;
    const refuseDestination = async (change: () => void, restore: () => void) => {
      let failed = false,
        first: unknown;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      try {
        change();
        await expect(
          prepareServiceOriginalRoomResponder(
            successor.http.service,
            nextRuntime,
            rejectedHolder,
            confirmedCanonicalId
          )
        ).rejects.toThrow('canonical destination');
      } catch (cause) {
        remember(cause);
      }
      try {
        restore();
      } catch (cause) {
        remember(cause);
      }
      if (failed) throw first;
    };
    let destinationFailed = false,
      destinationFailure: unknown;
    try {
      await refuseDestination(
        () =>
          successor.db.run(
            sql`DELETE FROM room_session_retirements WHERE retired_session_id=${sessionId}`
          ),
        () =>
          successor.db
            .run(sql`INSERT INTO room_session_retirements(retired_session_id,canonical_session_id,retired_at)
          VALUES(${sessionId},${retirement.canonical_session_id},${retirement.retired_at})`)
      );
      await refuseDestination(
        () =>
          successor.db.run(
            sql`UPDATE room_session_retirements SET canonical_session_id=${sessionId} WHERE retired_session_id=${sessionId}`
          ),
        () =>
          successor.db.run(
            sql`UPDATE room_session_retirements SET canonical_session_id=${canonicalId} WHERE retired_session_id=${sessionId}`
          )
      );
      await refuseDestination(
        () =>
          successor.db.run(
            sql`UPDATE session_metadata SET agent_path=${agentPath + '/foreign'} WHERE session_id=${canonicalId}`
          ),
        () =>
          successor.db.run(
            sql`UPDATE session_metadata SET agent_path=${agentPath} WHERE session_id=${canonicalId}`
          )
      );
    } catch (cause) {
      destinationFailed = true;
      destinationFailure = cause;
    }
    try {
      rejectedHolder.close();
    } catch (cause) {
      if (!destinationFailed) {
        destinationFailed = true;
        destinationFailure = cause;
      }
    }
    if (destinationFailed) throw destinationFailure;
    expect(readTestModeOriginalScenarioCounts(nextRuntime)).toEqual({ scenarioStarts: 0 });
    expect(successor.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
      0
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 110));
    port.wake();
    await port.pump(nextRegistry);
    await port.pump(nextRegistry);
    expect(readTestModeOriginalScenarioCounts(nextRuntime)).toEqual({ scenarioStarts: 1 });
    expect(successor.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(
      1
    );
    expect(successor.http.channels.getEvent(actual.documentId, request.eventId)).toEqual(event);
    expect(
      successor.db.get<Record<string, unknown>>(sql`SELECT * FROM canvas_doc_write_intents
      WHERE document_id=${actual.documentId} AND event_id=${request.eventId}`)
    ).toEqual(savedIntent);
    expect(
      successor.db.get<Record<string, unknown>>(
        sql`SELECT * FROM canvas_doc_batches WHERE document_id=${actual.documentId}`
      )
    ).toMatchObject({
      batch_id: before.batch_id,
      generation: before.generation,
      status: 'turn_done',
    });
    await port.pump(nextRegistry);
    expect(readTestModeOriginalScenarioCounts(nextRuntime)).toEqual({ scenarioStarts: 1 });
    const completed = successor.db.get<{ room_source_json: string; turn_id: string }>(
      sql`SELECT room_source_json,turn_id FROM canvas_doc_batches WHERE document_id=${actual.documentId}`
    )!;
    expect(completed.room_source_json).toBe(before.room_source_json);
    expect(completed.turn_id.startsWith(canonicalId + ':')).toBe(true);
    if (typeof before.grant_id !== 'string') throw new Error('Original grant identity is missing');
    expect(successor.http.channels.getGrant(before.grant_id)?.targetSessionId).toBe(sessionId);
  } catch (cause) {
    remember(cause);
  } finally {
    // Unblock the original held scenario before waiting for its captured return.
    if (!producerClosed) {
      try {
        await interrupt?.();
      } catch (cause) {
        remember(cause);
      }
      try {
        if (originalReturn) await originalReturn();
        producerClosed = true;
      } catch (cause) {
        remember(cause);
      }
    }
    if (producerClosed) {
      try {
        runtime?.releaseLock(key, clientId, token);
        holder.close();
      } catch (cause) {
        remember(cause);
        producerClosed = false;
      }
    }
    try {
      restorePublicId?.();
    } catch (cause) {
      remember(cause);
    }
    try {
      stopFollowing?.();
    } catch (cause) {
      remember(cause);
    }
    if (h && producerClosed && !ownersClosed) {
      let unknown = false;
      await Promise.allSettled([
        stopInstallationFileWrites(h.http.fileWrites, h.db, h.http.channels).catch((cause) => {
          unknown = true;
          remember(cause);
        }),
        currentRoomDueServicePort(h.http.service)
          .stopPump()
          .catch((cause) => {
            unknown = true;
            remember(cause);
          }),
      ]);
      ownersClosed = !unknown;
    }
    if (producerClosed && ownersClosed) {
      try {
        await reopened?.cleanup();
      } catch (cause) {
        remember(cause);
        ownersClosed = false;
      }
      if (ownersClosed)
        try {
          await h?.cleanup();
        } catch (cause) {
          remember(cause);
          ownersClosed = false;
        }
    }
    try {
      scenarioStore.clearSession(sessionId);
      if (canonicalId) scenarioStore.clearSession(canonicalId);
      disposeProjector(key);
    } catch (cause) {
      remember(cause);
    }
    if (producerClosed && ownersClosed)
      try {
        await fs.rm(agentPath, { recursive: true, force: true });
      } catch (cause) {
        remember(cause);
      }
    serverEnv.DORKOS_TEST_RUNTIME = oldMode;
  }
  if (failed) throw first;
});
