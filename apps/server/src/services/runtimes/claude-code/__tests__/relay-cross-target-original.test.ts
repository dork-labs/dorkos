/** Original configured Relay → Claude native claim/FIRST → fake SDK transport + real child. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { agents, eq, sessionMetadata, sessionMessageAcceptanceReceipts } from '@dorkos/db';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { createPrivateDocPumpGates } from '../../../canvas/doc-channel/delivery/private-gates.js';
import { DocBatchDeliveryPump } from '../../../canvas/doc-channel/delivery/pump.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { MeshCore } from '@dorkos/mesh';
import { RelayCore, AdapterRegistry, ClaudeCodeAdapter } from '@dorkos/relay';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { nativeRelayFixture } from '../../../canvas/doc-channel/__tests__/relay-native-fixture.js';
import { subscribeCommittedDocEvents } from '../../../canvas/doc-channel/committed-events.js';
import {
  createDocumentRelaySourceAuthority,
  wakeOriginalRelayAcceptedReceipts,
} from '../../../canvas/doc-channel/delivery/relay-authority.js';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { initAgentIdentityService } from '../../../core/agent-identity/agent-identity-service.js';
import { setAgentHomeRegistry } from '../../../core/agent-identity/agent-home.js';
import { docInstallationOwner } from '../../../canvas/doc-channel/current/doc-source-policy.js';
import { disposeProjector } from '../../../session/session-state-projector.js';
import { initBoundary } from '../../../../lib/boundary.js';
import {
  ClaudeCodeRuntime,
  driveClaudeOriginalRelayDocument,
  stopClaudeOriginalRelayDocumentDrive,
  readOriginalClaudeRelayClosedTurn,
} from '../claude-code-runtime.js';
import * as originalClaudeRuntime from '../claude-code-runtime.js';
import { sdkSimpleText, wrapSdkQuery } from './sdk-scenarios.js';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
// Avoid the optional CLI locator's PATH subprocess. Launch options, policy,
// native principal, source, projector and real process custody remain original.
vi.mock('../sdk/sdk-utils.js', async (original) => ({
  ...(await original<typeof import('../sdk/sdk-utils.js')>()),
  resolveClaudeCliPath: () => undefined,
  resolveClaudeBinaryBeforePath: () => null,
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  let failed = false;
  let first: unknown;
  try {
    await Promise.allSettled(
      cleanup.splice(0).map(async (stop) => {
        try {
          await stop();
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      })
    );
  } finally {
    setAgentHomeRegistry(undefined);
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  }
  if (failed) throw first;
});
async function fixture(waitBeforeInstall = false) {
  let clockTime = Date.now() - (waitBeforeInstall ? 2 * 60 * 60_000 : 0);
  const clock = () => new Date(clockTime);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'relay-native-sdk-')));
  const agentPath = join(directory, 'agent'),
    home = join(directory, 'dork-home'),
    targetPath = join(directory, 'target');
  await mkdir(agentPath);
  await mkdir(home);
  await mkdir(targetPath);
  vi.stubEnv('DORK_HOME', home);
  initConfigManager(home);
  await initBoundary(directory);
  const f = nativeRelayFixture(join(directory, 'db.sqlite'), null, 'sdk-original', 'claude-code', {
    clock,
    agentPath,
    targetAgentPath: targetPath,
  });
  const nativeDrains: (() => Promise<void>)[] = [];
  const peerDrains: (() => Promise<void>)[] = [];
  cleanup.push(async () => {
    let failed = false;
    let first: unknown;
    const retain = (cause: unknown) => {
      if (!failed) {
        failed = true;
        first = cause;
      }
    };
    const settle = async (owners: (() => Promise<void>)[]) => {
      await Promise.allSettled(
        owners.map(async (drain) => {
          try {
            await drain();
          } catch (cause) {
            retain(cause);
          }
        })
      );
    };
    // Start native drive/principal and sink drains independently. Their actual
    // positive resolution is required before retiring the original projector.
    await settle(nativeDrains);
    const nativeClosed = !failed;
    // Registry, bus and registry-maintenance peers are attempted even on UNKNOWN.
    await settle(peerDrains);
    if (nativeClosed) {
      try {
        disposeProjector('session-1');
        disposeProjector('other-session');
      } catch (cause) {
        retain(cause);
      }
    }
    if (failed) throw first; // Preserve Db/files while any original owner is unresolved.
    f.db.$client.close();
    await rm(directory, { recursive: true, force: true });
  });
  initAgentIdentityService(f.db);
  const mesh = new MeshCore({ db: f.db, defaultScanRoot: directory, strategies: [] });
  peerDrains.push(async () => {
    mesh.close();
  });
  setAgentHomeRegistry({
    isRegisteredHome: (path) => mesh.getByPath(path) !== undefined,
    listRegisteredHomes: () => mesh.listWithPaths().map((agent) => agent.projectPath),
    managedWorkspaceOwner: () => null,
    roomsDir: join(home, 'rooms'),
  });
  const principals = new ConnectorRuntimePrincipalService({
    db: f.db,
    authority: {
      async authorizeTurn(input) {
        const agent = f.db.select().from(agents).where(eq(agents.id, 'agent-2')).get();
        const session = f.db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'other-session'))
          .get();
        if (
          !agent ||
          agent.status !== 'active' ||
          agent.projectPath !== input.agentPath ||
          agent.runtime !== input.runtime ||
          !session ||
          session.agentPath !== input.agentPath ||
          session.runtime !== input.runtime ||
          input.canonicalSessionId !== session.sessionId ||
          input.canonicalCwd !== targetPath
        )
          throw new Error('Actual configured target unavailable');
        return { owner: docInstallationOwner('installation'), agentId: agent.id };
      },
      async revalidateTurn(claims) {
        const agent = f.db.select().from(agents).where(eq(agents.id, claims.agentId)).get();
        const session = f.db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, claims.canonicalSessionId))
          .get();
        return (
          !!agent &&
          agent.status === 'active' &&
          agent.projectPath === claims.agentPath &&
          agent.runtime === claims.runtime &&
          !!session &&
          session.agentPath === claims.agentPath &&
          session.runtime === claims.runtime &&
          claims.owner.kind === 'local_install' &&
          claims.owner.installationId === 'installation'
        );
      },
    },
  });
  await principals.initializeBoot();
  const runtime = new ClaudeCodeRuntime(home, targetPath);
  runtime.setMeshCore(mesh);
  runtime.setConnectorRuntimeTools({
    principals,
    listenerUrl: 'http://127.0.0.1:1/mcp',
    agentToolsUrl: 'http://127.0.0.1:1/capabilities',
    isConnectorCapabilityId: () => false,
  });
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.setDb(f.db);
  runtimeRegistry.register(runtime);
  const protectedGates = createPrivateDocPumpGates({
    grants: f.grants,
    runtimes: runtimeRegistry,
    now: clock,
  });
  const nudge = vi.fn(() => undefined);
  const pump = new DocBatchDeliveryPump({
    db: f.db,
    store: f.store,
    grants: f.grants,
    admission: f.admission,
    now: clock,
    ...protectedGates,
    nudge,
    markWaitingWarning: () => false,
  });
  let waitingBatch: ReturnType<typeof f.store.getBatch>;
  if (waitBeforeInstall) {
    f.input({
      checked: true,
      targetSession: 'session-1',
      targetAgent: 'agent-1',
      grantId: 'page-hostile',
    });
    f.input({ checked: false });
    clockTime += 1001;
    expect(pump.run()).toMatchObject({ admitted: 0, waiting: 1 });
    waitingBatch = f.store.getBatch(f.batchId());
    expect(waitingBatch).toMatchObject({
      status: 'waiting',
      errorCode: 'relay_disabled',
      admissionReceiptId: null,
    });
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled();
    clockTime = Date.now();
  }
  const registry = new AdapterRegistry();
  const { relay: bus, origin } = RelayCore.createServerDocumentRelay({
    dataDir: join(directory, 'relay'),
    adapterRegistry: registry,
  });
  const transported: RelayEnvelope[] = [];
  const stopObserve = bus.subscribe('relay.doc.batch', (envelope) => {
    transported.push(envelope);
  });
  peerDrains.push(async () => {
    stopObserve();
  });
  peerDrains.push(() => bus.close());
  peerDrains.push(() => registry.shutdown());
  await bus.registerEndpoint('relay.system.sdk-control');
  bus.addAccessRule({
    from: 'relay.agent.agent-1',
    to: 'relay.agent.agent-2',
    action: 'allow',
    priority: 100,
  });
  const installed = ClaudeCodeAdapter.createInstalledDocumentAdapter(
    'original-claude',
    { maxConcurrent: 1, defaultCwd: targetPath },
    {
      agentManager: runtime,
      agentRuntimes: new Map([['claude-code', runtime]]),
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
      approvalAuthorizer: () => false,
    }
  );
  await registry.register(installed.adapter);
  const sourceOwner = createDocumentRelaySourceAuthority(
    origin,
    f.store,
    f.grants,
    principals,
    f.db,
    f.serverNativeRelayConstruction,
    installed.origin
  );
  let expectedSinkFailure = false,
    expectedSinkCause: unknown;
  const expectSinkFailure = (cause: unknown) => {
    expectedSinkFailure = true;
    expectedSinkCause = cause;
  };
  nativeDrains.push(async () => {
    if (!expectedSinkFailure) return sourceOwner.stopOriginalNativeSink();
    const outcome = await sourceOwner.stopOriginalNativeSink().then(
      () => ({ failed: false, cause: undefined }),
      (cause: unknown) => ({ failed: true, cause })
    );
    expect(outcome.failed).toBe(true);
    expect(outcome.cause).toBe(expectedSinkCause);
  });
  if (!waitBeforeInstall) {
    f.input({ checked: true });
    f.input({ checked: false });
  }
  const batchId = f.batchId();
  if (waitBeforeInstall) {
    expect(pump.run()).toMatchObject({ admitted: 1, waiting: 0 });
    expect(pump.run().admitted).toBe(0);
  } else f.admission.admit(batchId);
  const batch = f.store.getBatch(batchId)!;
  const source = sourceOwner.prepareOriginalNativeSource(batchId, batch.generation);
  let driveStarted = false;
  const stop = () => stopClaudeOriginalRelayDocumentDrive(runtime, source);
  nativeDrains.push(async () => {
    if (driveStarted) await stop();
  });
  const drive = () => {
    driveStarted = true;
    return driveClaudeOriginalRelayDocument(runtime, source);
  };
  const receipt = () =>
    f.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, batch.admissionReceiptId!))
      .get()!;
  const queueCount = () =>
    f.db.$client
      .prepare('SELECT count(*) n FROM session_message_queue WHERE id=?')
      .get(receipt().queueMessageId) as { n: number };
  return {
    f,
    runtime,
    source,
    sourceOwner,
    stop,
    drive,
    batch,
    receipt,
    queueCount,
    agentPath,
    targetPath,
    transported,
    waitingBatch,
    bus,
    protectedGates,
    expectSinkFailure,
  };
}
it('operator-approved other-agent route reaches its protected sink once while source scope remains original', async () => {
  const own = await fixture(true),
    settled = deferred<void>();
  let child: ChildProcessWithoutNullStreams | undefined;
  vi.mocked(query).mockImplementation((input) => {
    expect(own.receipt().state).toBe('turn_started');
    expect(input.options?.cwd).toBe(own.targetPath);
    expect(input.options?.cwd).not.toBe(own.agentPath);
    expect(own.receipt().turnStartSeq).toBeGreaterThan(0);
    expect(own.queueCount()).toEqual({ n: 0 });
    const spawn = input.options?.spawnClaudeCodeProcess;
    if (!spawn) throw new Error('Original SDK process launcher missing.');
    child = spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      env: {},
      signal: new AbortController().signal,
    }) as ChildProcessWithoutNullStreams;
    return wrapSdkQuery(
      sdkSimpleText('Native protected sink transport', 'other-session')
    ) as unknown as ReturnType<typeof query>;
  });
  // A payload-free post-COMMIT hint only wakes the actual durable-row read.
  const unsubscribe = subscribeCommittedDocEvents(own.f.db, (documentId) => {
    if (documentId === own.f.documentId && own.receipt().state === 'settled') settled.resolve();
    return undefined;
  });
  try {
    const acceptedBefore = own.receipt();
    // One disabled-wait lease and one admission lease precede native FIRST.
    expect(own.waitingBatch!.attempt).toBe(1);
    const beforeNativeAttempt = own.batch.attempt;
    expect(beforeNativeAttempt).toBe(2);
    expect(acceptedBefore.dispatchAttemptId).toBeNull();
    expect(own.batch.scope).toBe('session:session-1');
    expect(acceptedBefore).toMatchObject({
      sessionId: 'other-session',
      agentId: 'agent-2',
      originAgentPath: own.targetPath,
    });
    expect(own.f.store.getGrant(own.f.grantId)).toMatchObject({
      targetAgentId: 'agent-2',
      targetSessionId: 'other-session',
    });
    expect(own.f.store.getGrant(own.f.grantId)?.approvalId).not.toBeNull();
    const readStatuses = () =>
      own.f.db.$client
        .prepare(
          "SELECT * FROM canvas_doc_events WHERE document_id=? AND type='event.status' ORDER BY doc_seq"
        )
        .all(own.f.documentId);
    const priorStatuses = readStatuses();
    const genericPrepared = await own.f.admission.acceptance.prepare(acceptedBefore.id);
    expect(() => own.f.admission.acceptance.claim(acceptedBefore.id, genericPrepared)).toThrow(
      'original native Relay dispatcher'
    );
    expect(own.receipt()).toEqual(acceptedBefore);
    expect(own.queueCount()).toEqual({ n: 1 });
    expect(query).not.toHaveBeenCalled();
    const ordinary = await wakeOriginalRelayAcceptedReceipts(
      own.sourceOwner,
      own.f.db,
      'other-session',
      [own.receipt().id]
    );
    expect(ordinary).toEqual([]);
    await settled.promise;
    expect(own.transported).toHaveLength(1);
    const envelope = own.transported[0]!;
    expect(envelope.payload).toEqual({
      documentId: own.f.documentId,
      batchId: own.batch.batchId,
      generation: own.batch.generation,
      openerAgentId: 'agent-1',
      targetAgentId: 'agent-2',
    });
    expect(Object.keys(envelope.payload as object).sort()).toEqual([
      'batchId',
      'documentId',
      'generation',
      'openerAgentId',
      'targetAgentId',
    ]);
    expect(Date.parse(envelope.createdAt) - Date.parse(own.waitingBatch!.dueAt)).toBeGreaterThan(
      60 * 60_000
    );
    expect(envelope.budget.ttl - Date.parse(envelope.createdAt)).toBeGreaterThanOrEqual(
      3_600_000 - 1000
    );
    expect(envelope.budget.ttl - Date.parse(envelope.createdAt)).toBeLessThanOrEqual(
      3_600_000 + 1000
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(own.receipt()).toMatchObject({ state: 'settled', settleOutcome: 'completed' });
    expect(own.receipt().dispatchAttemptId).toEqual(expect.any(String));
    expect(own.f.store.getBatch(own.batch.batchId)).toMatchObject({
      status: 'turn_done',
      attempt: beforeNativeAttempt + 1,
    });
    expect(own.queueCount()).toEqual({ n: 0 });
    const rows = own.f.db.$client
      .prepare('SELECT * FROM canvas_doc_deliveries WHERE batch_id=? ORDER BY event_id')
      .all(own.batch.batchId) as { status: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'turn_done')).toBe(true);
    const allStatuses = readStatuses();
    expect(allStatuses.slice(0, priorStatuses.length)).toEqual(priorStatuses);
    const statuses = allStatuses.slice(priorStatuses.length).map((row) => ({
      provenance: (row as { provenance: string }).provenance,
    }));
    expect(statuses).toEqual([
      { provenance: '{"source":"doc-channel-service"}' },
      { provenance: '{"source":"doc-channel-service"}' },
    ]);
    expect(child?.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    expect(own.sourceOwner.readOriginalSinkDiagnostic()).toMatchObject({
      active: 0,
      operationalFailed: false,
    });
    await own.sourceOwner.stopOriginalNativeSink();
  } finally {
    unsubscribe();
  }
});

it('competing original drives reuse one other-agent native claim and cannot consume its process custody twice', async () => {
  const own = await fixture();
  let child: ChildProcessWithoutNullStreams | undefined;
  vi.mocked(query).mockImplementation((input) => {
    expect(own.receipt()).toMatchObject({ state: 'turn_started' });
    expect(own.receipt().turnStartSeq).toBeGreaterThan(0);
    expect(own.queueCount()).toEqual({ n: 0 });
    expect(own.f.store.getBatch(own.batch.batchId)).toMatchObject({
      status: 'turn_started',
      attempt: 1,
    });
    expect(input.options?.cwd).toBe(own.targetPath);
    expect(own.receipt().agentId).toBe('agent-2');
    expect(own.batch.scope).toBe('session:session-1');
    const spawn = input.options?.spawnClaudeCodeProcess;
    if (!spawn) throw new Error('Original SDK process launcher missing.');
    child = spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      env: {},
      signal: new AbortController().signal,
    }) as ChildProcessWithoutNullStreams;
    expect(() =>
      spawn({ command: process.execPath, args: [], env: {}, signal: new AbortController().signal })
    ).toThrow('consumed');
    return wrapSdkQuery(
      sdkSimpleText('Transport-only response', 'other-session')
    ) as unknown as ReturnType<typeof query>;
  });
  const drive = own.drive();
  expect(driveClaudeOriginalRelayDocument(own.runtime, own.source)).toBe(drive);
  await expect(drive).resolves.toBe('drained');
  expect(query).toHaveBeenCalledTimes(1);
  expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  expect(child?.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
  expect(readOriginalClaudeRelayClosedTurn(own.runtime, own.source)).toMatchObject({
    kind: 'original-claude-relay-closed-turn',
  });
  // This direct original drive exercises terminal policy/closure, not sink ledger settlement.
});

it('other-agent claimed turn stays uncertain after cancellation with held SDK return and closes its actual child', async () => {
  const own = await fixture(),
    started = deferred<void>(),
    releaseReturn = deferred<void>(),
    releaseNext = deferred<void>();
  let child: ChildProcessWithoutNullStreams | undefined;
  let childClosed: Promise<unknown> | undefined;
  const sdkReturn = vi.fn(async () => {
    await releaseReturn.promise;
    return { done: true as const, value: undefined };
  });
  vi.mocked(query).mockImplementation((input) => {
    expect(own.receipt().state).toBe('turn_started');
    expect(own.queueCount()).toEqual({ n: 0 });
    const spawn = input.options?.spawnClaudeCodeProcess;
    if (!spawn) throw new Error('Original SDK process launcher missing.');
    child = spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      env: {},
      signal: new AbortController().signal,
    }) as ChildProcessWithoutNullStreams;
    childClosed = once(child, 'close');
    const transport = wrapSdkQuery(
      (async function* () {
        started.resolve();
        await releaseNext.promise;
      })()
    );
    transport.close.mockImplementation(() => releaseNext.resolve());
    transport.return = sdkReturn;
    return transport as unknown as ReturnType<typeof query>;
  });
  const drive = own.drive();
  const outcome = drive.then(
    () => ({ refused: false }),
    () => ({ refused: true })
  );
  try {
    await Promise.race([
      started.promise,
      drive.then(() => {
        throw new Error('Original drive ended before transport hold');
      }),
    ]);
    const stopping = own.stop();
    let settled = false;
    const stopped = stopping.then(() => {
      settled = true;
    });
    if (!childClosed) throw new Error('Original SDK spawn did not return an actual child');
    await childClosed;
    expect(sdkReturn).toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(child?.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    releaseReturn.resolve();
    await stopped;
    expect(await outcome).toEqual({ refused: true });
    expect(() => readOriginalClaudeRelayClosedTurn(own.runtime, own.source)).toThrow('UNKNOWN');
    expect(own.receipt()).toMatchObject({ state: 'turn_started', settleOutcome: null });
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    releaseNext.resolve();
    releaseReturn.resolve();
    await own.stop();
  }
});

it('a current explicit opener ACL denial blocks the genuine installed cross-target gate and protected publication before any native slot', async () => {
  const own = await fixture();
  own.bus.addAccessRule({
    from: 'relay.agent.agent-1',
    to: 'relay.agent.agent-2',
    action: 'deny',
    priority: 1000,
  });
  const before = own.receipt();
  expect(own.f.store.transaction((tx) => own.protectedGates.capacity(own.batch, tx))).toMatchObject(
    { available: false, reason: 'relay_access_denied' }
  );
  expect(() =>
    own.sourceOwner.publishAcceptedWake(own.batch.batchId, own.batch.generation)
  ).toThrow();
  expect(own.receipt()).toEqual(before);
  expect(own.receipt().state).toBe('accepted');
  expect(own.queueCount()).toEqual({ n: 1 });
  expect(own.transported).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});

it.each([undefined, false, 0, ''])(
  'shutdown preserves original sink rejection %j after successful physical drain',
  async (cause) => {
    const own = await fixture();
    own.expectSinkFailure(cause);
    let child: ChildProcessWithoutNullStreams | undefined;
    vi.mocked(query).mockImplementation((input) => {
      const spawn = input.options?.spawnClaudeCodeProcess;
      if (!spawn) throw new Error('Original SDK process launcher missing.');
      child = spawn({
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        env: {},
        signal: new AbortController().signal,
      }) as ChildProcessWithoutNullStreams;
      return wrapSdkQuery(
        (async function* () {
          throw cause;
        })()
      ) as unknown as ReturnType<typeof query>;
    });
    await own.sourceOwner.publishAcceptedWake(own.batch.batchId, own.batch.generation);
    await vi.waitFor(() =>
      expect(own.sourceOwner.readOriginalSinkDiagnostic()).toMatchObject({
        active: 0,
        operationalFailed: true,
      })
    );
    expect(child).toBeDefined();
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    expect(child?.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    const outcome = await own.sourceOwner.stopOriginalNativeSink().then(
      () => ({ failed: false, cause: undefined }),
      (error: unknown) => ({ failed: true, cause: error })
    );
    expect(outcome.failed).toBe(true);
    expect(outcome.cause).toBe(cause);
    expect(own.sourceOwner.stopOriginalNativeSink()).toBe(own.sourceOwner.stopOriginalNativeSink());
    expect(own.receipt()).toMatchObject({ state: 'turn_started', settleOutcome: null });
    expect(query).toHaveBeenCalledTimes(1);
  }
);

it('shutdown joins held original cleanup before reporting the sink failure recorded during drain', async () => {
  const own = await fixture(),
    returning = deferred<void>(),
    releaseReturn = deferred<void>(),
    cause = new Error('Original supplied SDK stream failed');
  own.expectSinkFailure(cause);
  let child: ChildProcessWithoutNullStreams | undefined;
  vi.mocked(query).mockImplementation((input) => {
    const spawn = input.options?.spawnClaudeCodeProcess;
    if (!spawn) throw new Error('Original SDK process launcher missing.');
    child = spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      env: {},
      signal: new AbortController().signal,
    }) as ChildProcessWithoutNullStreams;
    const transport = wrapSdkQuery(
      (async function* () {
        throw cause;
      })()
    );
    transport.return = vi.fn(async () => {
      returning.resolve();
      await releaseReturn.promise;
      return { done: true as const, value: undefined };
    });
    return transport as unknown as ReturnType<typeof query>;
  });
  try {
    await own.sourceOwner.publishAcceptedWake(own.batch.batchId, own.batch.generation);
    await returning.promise;
    expect(own.sourceOwner.readOriginalSinkDiagnostic()).toMatchObject({
      active: 1,
      operationalFailed: false,
    });
    const stopping = own.sourceOwner.stopOriginalNativeSink();
    let settled = false;
    const outcome = stopping.then(
      () => {
        settled = true;
        return { failed: false, cause: undefined };
      },
      (error: unknown) => {
        settled = true;
        return { failed: true, cause: error };
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseReturn.resolve();
    const result = await outcome;
    expect(result.failed).toBe(true);
    expect(result.cause).toBe(cause);
    expect(child).toBeDefined();
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    expect(child?.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    expect(own.sourceOwner.readOriginalSinkDiagnostic()).toMatchObject({
      active: 0,
      operationalFailed: true,
    });
    expect(own.receipt()).toMatchObject({ state: 'turn_started', settleOutcome: null });
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    releaseReturn.resolve();
  }
});

it.each([undefined, new Error('Original drive failure before cleanup')])(
  'shutdown preserves the already-observed original drive cause %j ahead of concurrent cleanup failure',
  async (cause) => {
    const own = await fixture(),
      releaseOriginalCleanup = deferred<void>(),
      secondary = new Error('Later concurrent sink cleanup failure');
    own.expectSinkFailure(cause);
    let child: ChildProcessWithoutNullStreams | undefined,
      originalCleanupEntered = false,
      stopCalls = 0;
    const originalStop = originalClaudeRuntime.stopClaudeOriginalRelayDocumentDrive;
    // Fault only the cleanup observer after the genuine captured owner has drained.
    // No source, claim, native closure or supplied-child authority is mocked.
    const stopSpy = vi
      .spyOn(originalClaudeRuntime, 'stopClaudeOriginalRelayDocumentDrive')
      .mockImplementation(async (...args) => {
        await originalStop(...args);
        stopCalls++;
        if (stopCalls === 1) {
          originalCleanupEntered = true;
          await releaseOriginalCleanup.promise;
          return;
        }
        throw secondary;
      });
    vi.mocked(query).mockImplementation((input) => {
      const spawn = input.options?.spawnClaudeCodeProcess;
      if (!spawn) throw new Error('Original SDK process launcher missing.');
      child = spawn({
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        env: {},
        signal: new AbortController().signal,
      }) as ChildProcessWithoutNullStreams;
      return wrapSdkQuery(
        (async function* () {
          throw cause;
        })()
      ) as unknown as ReturnType<typeof query>;
    });
    try {
      await own.sourceOwner.publishAcceptedWake(own.batch.batchId, own.batch.generation);
      await vi.waitFor(() => expect(originalCleanupEntered).toBe(true));
      expect(child).toBeDefined();
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
      expect(child!.stdin.destroyed && child!.stdout.destroyed && child!.stderr.destroyed).toBe(
        true
      );
      expect(own.sourceOwner.readOriginalSinkDiagnostic()).toMatchObject({
        active: 1,
        operationalFailed: false,
      });
      const outcome = own.sourceOwner.stopOriginalNativeSink().then(
        () => ({ failed: false, cause: undefined }),
        (error: unknown) => ({ failed: true, cause: error })
      );
      // The second original stop peer reports Y while slot cleanup after X is still held.
      await vi.waitFor(() => expect(stopCalls).toBe(2));
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      releaseOriginalCleanup.resolve();
      const result = await outcome;
      expect(result.failed).toBe(true);
      expect(result.cause).toBe(cause);
      expect(result.cause).not.toBe(secondary);
      expect(own.sourceOwner.readOriginalSinkDiagnostic()).toMatchObject({
        active: 0,
        operationalFailed: true,
      });
      expect(own.receipt()).toMatchObject({ state: 'turn_started', settleOutcome: null });
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      releaseOriginalCleanup.resolve();
      stopSpy.mockRestore();
    }
  }
);
