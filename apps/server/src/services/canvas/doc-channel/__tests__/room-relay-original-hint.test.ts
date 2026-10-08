/** Protected bus identifiers wake the original native Room source; they never create a private turn. */
import { expect, it } from 'vitest';
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

it('protected Relay identifiers preserve the original Room deadline and duplicate hints still produce one native Room handoff', async () => {
  // Temporary fixed phase DATA; never participates in native/currentness decisions.
  let phaseRows = 0;
  let phaseNow: (() => number) | undefined;
  let phaseStart = -1;
  let phaseLast = -1;
  try {
    phaseNow = performance.now.bind(performance);
    phaseStart = phaseNow();
    if (!Number.isFinite(phaseStart) || phaseStart < 0) phaseStart = -1;
    phaseLast = phaseStart;
  } catch {}
  const phase = (
    label:
      | 'adapter-ready'
      | 'adapter-register-start'
      | 'body-failed'
      | 'cleanup-done'
      | 'cleanup-start'
      | 'due-wait-done'
      | 'due-wait-start'
      | 'filesystem-start'
      | 'fixture-ready'
      | 'fixture-start'
      | 'initial-hints-done'
      | 'initial-pump-done'
      | 'initial-pump-start'
      | 'native-evidence-checked'
      | 'native-pump-done'
      | 'native-pump-start'
      | 'runtime-ready'
      | 'sequential-hints-done'
      | 'sequential-hints-start'
      | 'source-ready'
      | 'stop-done'
      | 'stop-start'
      | 'submission-done'
      | 'submission-start'
      | 'terminal'
  ): void => {
    if (phaseRows >= 32) return;
    phaseRows++;
    try {
      const now = phaseNow?.();
      const elapsed =
        phaseStart >= 0 &&
        now !== undefined &&
        Number.isFinite(now) &&
        now >= phaseLast &&
        now - phaseStart <= 600000
          ? Math.round(now - phaseStart)
          : -1;
      if (elapsed >= 0) phaseLast = now!;
      console.info('[original-relay-body-phase]', { phase: label, elapsedMs: elapsed });
    } catch {}
  };
  phase('filesystem-start');
  const dir = await fs.mkdtemp(join(tmpdir(), 'original-room-relay-hint-'));
  const previousTestMode = serverEnv.DORKOS_TEST_RUNTIME;
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let port: ReturnType<typeof currentRoomDueServicePort> | undefined;
  let bus: RelayCore | undefined;
  let adapters: AdapterRegistry | undefined;
  let sourceOwner: ReturnType<typeof createDocumentRelaySourceAuthority> | undefined;
  let nativeClosed = true;
  let sessionId: string | undefined;
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
    serverEnv.DORKOS_TEST_RUNTIME = true;
    sessionId = randomUUID();
    phase('fixture-start');
    h = await nativeRoomAuthorityFixture(dir, 'claude-code', sessionId, randomUUID(), {
      coalesceWindowMs: 1000,
    });
    phase('fixture-ready');
    const runtime = new TestModeRuntime('claude-code', h.principals);
    captureTestModeOriginalRoomEmitter(runtime, h.http.fileWrites, h.db, h.http.channels);
    const registry = new RuntimeRegistry();
    registry.setDb(h.db);
    registry.register(runtime);
    scenarioStore.setForSession(sessionId, 'simple-text');
    phase('runtime-ready');
    const physical = h.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, h.documentId))
      .get()!;
    const channel = h.http.channels.getChannel(h.documentId)!;
    const id = randomUUID();
    phase('submission-start');
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
    phase('submission-done');
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
    phase('adapter-register-start');
    await adapters.register(installed.adapter);
    phase('adapter-ready');
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
    phase('source-ready');
    await sourceOwner.publishAcceptedWake(before.batch_id, before.generation);
    await sourceOwner.publishAcceptedWake(before.batch_id, before.generation);
    phase('initial-hints-done');
    expect(port.nextDueAt()).toBe(before.due_at);
    phase('initial-pump-start');
    await port.pump(registry);
    phase('initial-pump-done');
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_doc_admissions`)!.n).toBe(0);
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(0);
    // Wait for the genuine original deadline; identifiers cannot advance it.
    phase('due-wait-start');
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(before.due_at) - Date.now()) + 25)
    );
    phase('due-wait-done');
    // More than the finite concurrent publication bound must release each sequential slot.
    phase('sequential-hints-start');
    for (let i = 0; i < 110; i++)
      await sourceOwner.publishAcceptedWake(before.batch_id, before.generation);
    phase('sequential-hints-done');
    expect(sourceOwner.readOriginalSinkDiagnostic()).toMatchObject({
      active: 0,
      operationalFailed: false,
    });
    phase('native-pump-start');
    await Promise.all([port.pump(registry), port.pump(registry)]);
    phase('native-pump-done');
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_doc_admissions`)!.n).toBe(1);
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(1);
    expect(
      h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM session_message_acceptance_receipts`)!.n
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
    phase('native-evidence-checked');
    // A delayed publication of the same genuine generation after native completion is benign.
    await sourceOwner.publishAcceptedWake(before.batch_id, before.generation);
    expect(sourceOwner.readOriginalSinkDiagnostic()).toMatchObject({
      active: 0,
      operationalFailed: false,
    });
    await port.pump(registry);
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n).toBe(1);
    phase('stop-start');
    await port.stopPump();
    phase('stop-done');
    expect(port.hintRelay(h.documentId, before.batch_id, before.generation)).toBe(false);
  } catch (cause) {
    phase('body-failed');
    failed = true;
    first = cause;
  } finally {
    phase('cleanup-start');
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
    phase('cleanup-done');
  }
  phase('terminal');
  if (failed) throw first;
});
