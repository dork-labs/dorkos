/** Protected bus identifiers wake the original native Room source; they never create a private turn. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql, canvasDocuments, eq } from '@dorkos/db';
import { RelayCore, AdapterRegistry, ClaudeCodeAdapter } from '@dorkos/relay';
import { createDocumentRelaySourceAuthority } from '../delivery/relay-authority.js';
import { vi } from 'vitest';
import { env as serverEnv } from '../../../../env.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import {
  TestModeRuntime,
  captureTestModeOriginalRoomEmitter,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
import {
  currentRoomDueServicePort,
  submitCurrentDocEvent,
  readServiceOriginalRoomScenarioEvidence,
} from '../service.js';
import { docDocumentGeneration } from '../identity/incarnation.js';

// Arrangement has its own default hook budget; operational work retains the default body budget.
let dir: string;
let sessionId: string;
let fixture: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
let setupPending: Promise<void>;
let bodyPending: Promise<void> | undefined;
let bodyCleanupCompleted = false;
let fallbackCleanup: Promise<void> | undefined;
let lifecycleFailed = false;
let lifecycleFirst: unknown;
const rememberLifecycle = (cause: unknown) => {
  if (!lifecycleFailed) {
    lifecycleFailed = true;
    lifecycleFirst = cause;
  }
};
let previousTestMode: boolean;
beforeEach(async () => {
  fixture = undefined;
  bodyPending = undefined;
  bodyCleanupCompleted = false;
  fallbackCleanup = undefined;
  lifecycleFailed = false;
  lifecycleFirst = undefined;
  previousTestMode = serverEnv.DORKOS_TEST_RUNTIME;
  setupPending = (async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'original-room-relay-hint-'));
    serverEnv.DORKOS_TEST_RUNTIME = true;
    sessionId = randomUUID();
    fixture = await nativeRoomAuthorityFixture(dir, 'claude-code', sessionId, randomUUID(), {
      coalesceWindowMs: 1000,
    });
  })();
  // Observe rejection immediately while retaining this exact owning setup promise.
  void setupPending.catch(rememberLifecycle);
  await setupPending;
});
afterEach(async () => {
  await (fallbackCleanup ??= (async () => {
    // A Vitest timeout is not cancellation. Never close resources ahead of late setup/body work.
    await setupPending.catch(rememberLifecycle);
    if (bodyPending) await bodyPending.catch(rememberLifecycle);
    if (bodyCleanupCompleted) return;
    // No completed body teardown owns a returned fixture. Its genuine cleanup joins native drains.
    let closed = false;
    if (fixture) {
      try {
        await fixture.cleanup();
        closed = true;
      } catch (cause) {
        rememberLifecycle(cause);
      }
    }
    if (closed && !lifecycleFailed) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (cause) {
        rememberLifecycle(cause);
      }
    }
    serverEnv.DORKOS_TEST_RUNTIME = previousTestMode;
    if (lifecycleFailed) throw lifecycleFirst;
  })());
});

it('protected Relay identifiers preserve the original Room deadline and duplicate hints still produce one native Room handoff', () => {
  bodyPending = (async () => {
    const h = fixture;
    if (!h) throw new Error('Original per-test native fixture did not finish setup');
    let port: ReturnType<typeof currentRoomDueServicePort> | undefined;
    let bus: RelayCore | undefined;
    let adapters: AdapterRegistry | undefined;
    let sourceOwner: ReturnType<typeof createDocumentRelaySourceAuthority> | undefined;
    let nativeClosed = true;
    let failed = false,
      first: unknown;
    const cleanup = async (work: () => unknown | Promise<unknown>) => {
      try {
        await work();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    };
    try {
      const runtime = new TestModeRuntime('claude-code', h.principals);
      captureTestModeOriginalRoomEmitter(runtime, h.http.fileWrites, h.db, h.http.channels);
      const registry = new RuntimeRegistry();
      registry.setDb(h.db);
      registry.register(runtime);
      scenarioStore.setForSession(sessionId, 'simple-text');
      const physical = h.db
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.id, h.documentId))
        .get()!;
      const channel = h.http.channels.getChannel(h.documentId)!;
      const id = randomUUID();
      await submitCurrentDocEvent(
        h.http.service,
        h.documentId,
        {
          v: 1,
          id,
          type: 'md.comment',
          payload: { text: 'original Room source, not Relay-selected content' },
        },
        h.operator,
        { expectedGeneration: docDocumentGeneration(physical, channel) }
      );
      const before = h.db.get<{
        batch_id: string;
        generation: string;
        due_at: string;
        status: string;
      }>(sql`
      SELECT b.batch_id,b.generation,b.due_at,b.status FROM canvas_doc_batches b
      JOIN canvas_doc_deliveries d ON d.batch_id=b.batch_id WHERE d.event_id=${id}`)!;
      expect(before.status).toBe('pending');
      port = currentRoomDueServicePort(h.http.service);
      expect(port.hintRelay('foreign-document', before.batch_id, before.generation)).toBe(false);
      expect(port.hintRelay(h.documentId, 'foreign-batch', before.generation)).toBe(false);
      expect(port.hintRelay(h.documentId, before.batch_id, 'stale-generation')).toBe(false);
      adapters = new AdapterRegistry();
      const created = RelayCore.createServerDocumentRelay({
        dataDir: join(dir, 'relay'),
        adapterRegistry: adapters,
      });
      bus = created.relay;
      const target = h.granted.grant.targetAgentId!,
        opener = h.granted.grant.openerAgentId!;
      bus.addAccessRule({
        from: `relay.agent.${opener}`,
        to: `relay.agent.${target}`,
        action: 'allow',
        priority: 100,
      });
      const installed = ClaudeCodeAdapter.createInstalledDocumentAdapter(
        'original-room-claude',
        { maxConcurrent: 1, defaultCwd: dir },
        {
          agentManager: runtime,
          agentRuntimes: new Map([['claude-code', runtime]]),
          traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
          approvalAuthorizer: () => false,
        }
      );
      await adapters.register(installed.adapter);
      sourceOwner = createDocumentRelaySourceAuthority(
        created.origin,
        h.http.channels,
        h.http.grants,
        h.principals,
        h.db,
        h.serverNativeRelayConstruction,
        installed.origin,
        h.http.service
      );
      await sourceOwner.publishAcceptedWake(before.batch_id, before.generation);
      await sourceOwner.publishAcceptedWake(before.batch_id, before.generation);
      expect(port.nextDueAt()).toBe(before.due_at);
      await port.pump(registry);
      expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_doc_admissions`)!.n).toBe(
        0
      );
      expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(0);
      // Wait for the genuine original deadline; identifiers cannot advance it.
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(0, Date.parse(before.due_at) - Date.now()) + 25)
      );
      // More than the finite concurrent publication bound must release each sequential slot.
      for (let i = 0; i < 110; i++)
        await sourceOwner.publishAcceptedWake(before.batch_id, before.generation);
      expect(sourceOwner.readOriginalSinkDiagnostic()).toMatchObject({
        active: 0,
        operationalFailed: false,
      });
      await Promise.all([port.pump(registry), port.pump(registry)]);
      expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_doc_admissions`)!.n).toBe(
        1
      );
      expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(1);
      expect(
        h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM session_message_acceptance_receipts`)!
          .n
      ).toBe(0);
      expect(h.http.channels.getBatch(before.batch_id)).toMatchObject({
        generation: before.generation,
        status: 'turn_done',
      });
      expect(
        readServiceOriginalRoomScenarioEvidence(
          h.http.service,
          h.documentId,
          before.batch_id,
          before.generation
        )
      ).toMatchObject({ scenarioStarts: 1, retired: true });
      // A delayed publication of the same genuine generation after native completion is benign.
      await sourceOwner.publishAcceptedWake(before.batch_id, before.generation);
      expect(sourceOwner.readOriginalSinkDiagnostic()).toMatchObject({
        active: 0,
        operationalFailed: false,
      });
      await port.pump(registry);
      expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(1);
      await port.stopPump();
      expect(port.hintRelay(h.documentId, before.batch_id, before.generation)).toBe(false);
    } catch (cause) {
      failed = true;
      first = cause;
    } finally {
      try {
        await sourceOwner?.stopOriginalNativeSink();
      } catch (cause) {
        nativeClosed = false;
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      await cleanup(() => port?.stopPump());
      await cleanup(() => bus?.close());
      await cleanup(() => adapters?.shutdown());
      if (sessionId) await cleanup(() => scenarioStore.clearSession(sessionId!));
      if (nativeClosed) await cleanup(() => h?.cleanup());
      if (!failed) await cleanup(() => fs.rm(dir, { recursive: true, force: true }));
      serverEnv.DORKOS_TEST_RUNTIME = previousTestMode;
    }
    bodyCleanupCompleted = true;
    if (failed) throw first;
  })();
  void bodyPending.catch(rememberLifecycle);
  return bodyPending;
});
