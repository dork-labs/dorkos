import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { vi, type MockInstance } from 'vitest';
import type { Db } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import { MeshCore } from '@dorkos/mesh';
import { RuntimeRegistry } from '../../../../core/runtime-registry.js';
import { initConfigManager } from '../../../../core/config-manager.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../../core/agent-identity/index.js';
import {
  registerTestHomes,
  clearTestHomes,
} from '../../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { CanonicalConnectorRuntimeAuthorityResolver } from '../../../../connectors/principal/runtime-authority-resolver.js';
import { ConnectorRuntimePrincipalService } from '../../../../connectors/principal/runtime-principal-service.js';
import type { ConnectorOwnerAuthority } from '../../../../core/connections-lease/index.js';
import { ConnectorRegistry } from '../../../../connectors/registry.js';
import { ConnectorExecutionAuthorizationService } from '../../../../connectors/execution/authorization-service.js';
import { ConnectorAccessQueryService } from '../../../../connectors/execution/access-query-service.js';
import { ConnectorUsageStore } from '../../../../connectors/execution/usage-store.js';
import { ConnectorExecutionBroker } from '../../../../connectors/execution/execution-broker.js';
import { connectorExecutionDomain } from '../../../../connectors/execution/execution-capabilities.js';
import { createConnectorRuntimeMcpServer } from '../../../../connectors/execution/runtime-mcp-server.js';
import { composeRegistry } from '../../../../core/capabilities/index.js';
import { memoryDomain } from '../../../../memory/memory-capabilities.js';
import { startConnectorRuntimeMcpListener } from '../../../connector-mcp/listener.js';
import { createAgentRuntimeMcpServer } from '../../../connector-mcp/agent-runtime-server.js';
import { isConnectorRuntimeCapabilityId } from '../../../../connectors/runtime-capability-scope.js';
import { DoeRuntime } from '../../doe-runtime.js';
import { assembleDoeHost } from '../../tools.js';
import { model, inference } from '../runtime-fixture.js';
import { scriptedEngine } from './engine.js';

interface FixtureOptions {
  /** Pause the first resource read, then continue through the actual loader. */
  beforeResourceLoad?: () => Promise<void>;
}

type FixtureEngine = ReturnType<typeof scriptedEngine>;

interface ToolTurnFixture {
  home: string;
  desk: string;
  db: Db;
  sessions: RuntimeRegistry;
  runtime: DoeRuntime;
  engine: FixtureEngine;
  opens: MockInstance<ConnectorRuntimePrincipalService['openTurn']>;
  start(opts?: MessageOpts): Promise<{
    events: StreamEvent[];
    finished: Promise<void>;
    native: FixtureEngine['runs'][number];
  }>;
  makeStream(opts?: MessageOpts): ReturnType<DoeRuntime['sendMessage']>;
  caller(index?: number): ReturnType<ConnectorRuntimePrincipalService['resolveToolTurn']>;
  close(): Promise<void>;
}

/** Real host, MCP closures/listener, registry, identity and authority; only model execution is scripted. */
export async function toolTurnFixture(options: FixtureOptions = {}): Promise<ToolTurnFixture> {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'doe-tool-turn-')));
  const cleanup: Array<() => unknown | Promise<unknown>> = [
    () => rm(home, { recursive: true, force: true }),
  ];
  async function close() {
    const errors: unknown[] = [];
    for (const action of cleanup.splice(0).reverse()) {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Owned fixture cleanup failed');
  }
  try {
    initConfigManager(path.join(home, 'config'));
    const desk = path.join(home, 'desk');
    await mkdir(desk);
    registerTestHomes([home], { managed: { [desk]: home } });
    cleanup.push(clearTestHomes);
    const db: Db = createTestDb();
    cleanup.push(() => db.$client.close());
    const identity = initAgentIdentityService(db);
    cleanup.push(resetAgentIdentityService);
    const mesh = new MeshCore({ db, defaultScanRoot: home, logger: noopLogger });
    cleanup.push(() => mesh.close());
    await mesh.registerByPath(home, { name: 'Owned Doe', runtime: 'doe', capabilities: [] });
    await identity.mint({ agentPath: home, displayName: 'Owned Doe' });
    const sessions = new RuntimeRegistry();
    sessions.setDb(db);
    const owner = { kind: 'local_install', installationId: 'owned-test' } as const;
    const authority = new CanonicalConnectorRuntimeAuthorityResolver({ sessions, mesh, owner });
    const service = new ConnectorRuntimePrincipalService({ db, authority });
    await service.initializeBoot();
    const opens = vi.spyOn(service, 'openTurn');
    const connectors = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: owner.kind, ownerId: owner.installationId },
    });
    // Delegate ownership to the actual canonical resolver and live Mesh/session records, never a fabricated grant.
    const ownership = {
      ownsAgent: async (candidate: ConnectorOwnerAuthority, id: string) => {
        const agentPath = mesh.getProjectPath(id);
        if (!agentPath) return false;
        const current = await authority.authorizeTurn({
          runtime: 'doe',
          canonicalSessionId: 's1',
          agentPath,
          canonicalCwd: desk,
          signal: new AbortController().signal,
        });
        return current.agentId === id && isDeepStrictEqual(current.owner, candidate);
      },
    };
    const authorization = new ConnectorExecutionAuthorizationService(db, connectors, ownership);
    const access = new ConnectorAccessQueryService(db, ownership, connectors, service);
    const registry = composeRegistry([memoryDomain, connectorExecutionDomain], {
      logger: noopLogger,
      connectorExecutionDeps: {
        authorization,
        access,
        broker: new ConnectorExecutionBroker(authorization, new ConnectorUsageStore(db), {
          revalidate: (principal) => service.revalidatePrincipal(principal),
        }),
      },
    });
    const listener = await startConnectorRuntimeMcpListener({
      principals: service,
      serverFactory: (principal) => createConnectorRuntimeMcpServer(registry, principal),
      agentServerFactory: async (principal) => {
        if (principal.claims.kind !== 'runtime') throw new Error('Runtime principal required');
        const agent = await identity.describeAgent(principal.claims.agentPath);
        if (!agent) throw new Error('Owned identity missing');
        return createAgentRuntimeMcpServer(registry, principal, agent);
      },
    });
    cleanup.push(() => listener.close());
    const actualFetch = globalThis.fetch;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      );
      if (url.origin !== new URL(listener.url).origin)
        return Promise.reject(new Error('Fixture refuses external network'));
      return actualFetch(input, init);
    });
    cleanup.push(() => fetch.mockRestore());
    const engine = scriptedEngine();
    const runtime = new DoeRuntime({
      directory: path.join(home, 'runtime'),
      defaultCwd: desk,
      inference: () => inference,
      resolveModel: async () => model,
      engineFactory: engine.factory,
      assembleHost: async (launch) => {
        const host = await assembleDoeHost(launch);
        const beforeResourceLoad = options.beforeResourceLoad;
        if (beforeResourceLoad) {
          const load = host.resources.load.bind(host.resources);
          vi.spyOn(host.resources, 'load').mockImplementationOnce(async () => {
            await beforeResourceLoad();
            return load();
          });
        }
        return host;
      },
    });
    const streams: AsyncGenerator<StreamEvent>[] = [];
    cleanup.push(async () => {
      engine.close();
      await runtime.shutdown();
      for (const stream of streams) await stream.return(undefined);
    });
    sessions.register(runtime);
    runtime.setSessionSettings(sessions);
    runtime.setMeshCore(mesh);
    await sessions.persistSessionRuntime('s1', 'doe', { kind: 'interactive' }, home);
    await sessions.saveSessionSettings('s1', { permissionMode: 'default' });
    runtime.setConnectorRuntimeTools({
      principals: service,
      listenerUrl: listener.url,
      agentToolsUrl: listener.agentUrl,
      isConnectorCapabilityId: isConnectorRuntimeCapabilityId,
    });
    const makeStream = (opts?: MessageOpts) => {
      const stream = runtime.sendMessage('s1', 'Owned turn', {
        cwd: desk,
        forAgent: home,
        ...opts,
      });
      streams.push(stream);
      return stream;
    };
    const start = async (opts?: MessageOpts) => {
      const index = engine.runs.length;
      const events: StreamEvent[] = [];
      const stream = makeStream(opts);
      const finished = (async () => {
        for await (const event of stream) events.push(event);
      })();
      const native = await Promise.race([
        engine.next(index),
        finished.then(() => {
          throw new Error('Turn ended before model edge');
        }),
      ]);
      return { events, finished, native };
    };
    async function caller(index = opens.mock.results.length - 1) {
      const binding = await opens.mock.results[index]!.value;
      const resolved = await service.resolve({
        bearer: binding.bearer,
        expectedRuntime: 'doe',
        expectedCanonicalCwd: desk,
      });
      if (resolved.status !== 'resolved') throw new Error('Owned canonical principal missing');
      return service.resolveToolTurn(resolved.principal);
    }
    return {
      home,
      desk,
      db,
      sessions,
      runtime,
      engine,
      opens,
      start,
      makeStream,
      caller,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Fixture setup and cleanup failed', {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
