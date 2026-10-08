/** Original configured file-backed native fixture, shared only by SDK acquisition controls. */
import { afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agents, eq, sessionMetadata, sessionMessageAcceptanceReceipts } from '@dorkos/db';
import { MeshCore } from '@dorkos/mesh';
import { RelayCore, AdapterRegistry, ClaudeCodeAdapter } from '@dorkos/relay';
import { nativeRelayFixture } from '../../../canvas/doc-channel/__tests__/relay-native-fixture.js';
import { createDocumentRelaySourceAuthority } from '../../../canvas/doc-channel/delivery/relay-authority.js';
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
} from '../claude-code-runtime.js';
// Avoid the optional CLI locator's PATH subprocess. Launch options, policy,
// native principal, source, projector and real process custody remain original.
vi.mock('../sdk/sdk-utils.js', async (original) => ({
  ...(await original<typeof import('../sdk/sdk-utils.js')>()),
  resolveClaudeCliPath: () => undefined,
  resolveClaudeBinaryBeforePath: () => null,
}));
export function deferred<T>() {
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
export async function acquisitionFixture() {
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
    nativeDrains,
    agentPath,
  };
}
