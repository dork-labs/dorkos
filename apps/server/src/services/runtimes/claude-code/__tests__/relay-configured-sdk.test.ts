/** Original configured Relay → Claude native claim/FIRST → fake SDK transport + real child. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { agents, eq, sessionMetadata, sessionMessageAcceptanceReceipts } from '@dorkos/db';
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
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'relay-native-sdk-')));
  const agentPath = join(directory, 'agent'),
    home = join(directory, 'dork-home');
  await mkdir(agentPath);
  await mkdir(home);
  vi.stubEnv('DORK_HOME', home);
  initConfigManager(home);
  await initBoundary(directory);
  const f = nativeRelayFixture(join(directory, 'db.sqlite'), null, 'sdk-original', 'claude-code', {
    now: new Date().toISOString(),
    agentPath,
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
        const agent = f.db.select().from(agents).where(eq(agents.id, 'agent-1')).get();
        const session = f.db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'session-1'))
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
          input.canonicalCwd !== agentPath
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
  const runtime = new ClaudeCodeRuntime(home, agentPath);
  runtime.setMeshCore(mesh);
  runtime.setConnectorRuntimeTools({
    principals,
    listenerUrl: 'http://127.0.0.1:1/mcp',
    agentToolsUrl: 'http://127.0.0.1:1/capabilities',
    isConnectorCapabilityId: () => false,
  });
  const registry = new AdapterRegistry();
  const { relay: bus, origin } = RelayCore.createServerDocumentRelay({
    dataDir: join(directory, 'relay'),
    adapterRegistry: registry,
  });
  peerDrains.push(() => bus.close());
  peerDrains.push(() => registry.shutdown());
  await bus.registerEndpoint('relay.system.sdk-control');
  bus.addAccessRule({
    from: 'relay.agent.agent-1',
    to: 'relay.agent.agent-1',
    action: 'allow',
    priority: 100,
  });
  const installed = ClaudeCodeAdapter.createInstalledDocumentAdapter(
    'original-claude',
    { maxConcurrent: 1, defaultCwd: agentPath },
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
  nativeDrains.push(() => sourceOwner.stopOriginalNativeSink());
  f.input({ checked: true });
  f.input({ checked: false });
  const batchId = f.batchId();
  f.admission.admit(batchId);
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
  return { f, runtime, source, sourceOwner, stop, drive, batch, receipt, queueCount };
}
it('original native receipt/projector FIRST precedes one SDK query and one actual supplied spawn; natural policy completion closes original turn', async () => {
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
    expect(input.options?.cwd).toBe(own.receipt().originAgentPath);
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
      sdkSimpleText('Transport-only response', 'session-1')
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
it('original active cancellation physically closes the real child while SDK return is held and never mints completed terminal evidence', async () => {
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

it('original accepted-receipt partition publishes through protected configured sink and settles native ledger after genuine policy and physical closure', async () => {
  const own = await fixture(),
    settled = deferred<void>();
  let child: ChildProcessWithoutNullStreams | undefined;
  vi.mocked(query).mockImplementation((input) => {
    expect(own.receipt().state).toBe('turn_started');
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
      sdkSimpleText('Native protected sink transport', 'session-1')
    ) as unknown as ReturnType<typeof query>;
  });
  // A payload-free post-COMMIT hint only wakes the actual durable-row read.
  const unsubscribe = subscribeCommittedDocEvents(own.f.db, (documentId) => {
    if (documentId === own.f.documentId && own.receipt().state === 'settled') settled.resolve();
    return undefined;
  });
  try {
    const acceptedBefore = own.receipt();
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
      'session-1',
      [own.receipt().id]
    );
    expect(ordinary).toEqual([]);
    await settled.promise;
    expect(query).toHaveBeenCalledTimes(1);
    expect(own.receipt()).toMatchObject({ state: 'settled', settleOutcome: 'completed' });
    expect(own.f.store.getBatch(own.batch.batchId)).toMatchObject({
      status: 'turn_done',
      attempt: 1,
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
