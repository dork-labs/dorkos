import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi, type MockInstance } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { MeshCore } from '@dorkos/mesh';
import { noopLogger } from '@dorkos/shared/logger';
import { RuntimeRegistry } from '../../../../core/runtime-registry.js';
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
import { initConfigManager } from '../../../../core/config-manager.js';
import { isConnectorRuntimeCapabilityId } from '../../../../connectors/runtime-capability-scope.js';
import type { RuntimeToolCaller } from '../../../../core/connections-lease/index.js';
import { OpenCodeRuntime } from '../../opencode-runtime.js';
import { OpenCodeSessionMap } from '../../sessions/session-map.js';
import { sessionIdle } from '../opencode-sse-fixtures.js';
import { scriptedSidecar } from './sidecar.js';

interface TurnRun {
  events: StreamEvent[];
  finished: Promise<void>;
  stream: AsyncGenerator<StreamEvent>;
}
interface ToolTurnFixture {
  home: string;
  desk: string;
  db: Db;
  mesh: MeshCore;
  sessions: RuntimeRegistry;
  service: ConnectorRuntimePrincipalService;
  runtime: OpenCodeRuntime;
  sidecar: ReturnType<typeof scriptedSidecar>;
  opens: MockInstance<ConnectorRuntimePrincipalService['openTurn']>;
  start(
    opts?: MessageOpts,
    observe?: (event: StreamEvent) => void | Promise<void>
  ): Promise<TurnRun>;
  makeStream(opts?: MessageOpts): AsyncGenerator<StreamEvent>;
  caller(index?: number): Promise<RuntimeToolCaller>;
  nativeId(): Promise<string>;
  finish(): Promise<void>;
  close(): Promise<void>;
}

/** Real runtime, Registry/Mesh/SQLite/principal; only SDK sidecar responses are scripted. */
export async function toolTurnFixture(): Promise<ToolTurnFixture> {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'opencode-tool-turn-')));
  initConfigManager(path.join(home, 'test-config'));
  const desk = path.join(home, 'worktree');
  await mkdir(desk);
  registerTestHomes([home], { managed: { [desk]: home } });
  const db: Db = createTestDb();
  initAgentIdentityService(db);
  const mesh = new MeshCore({ db, defaultScanRoot: home, logger: noopLogger });
  await mesh.registerByPath(home, {
    name: 'Tool turn fixture',
    runtime: 'opencode',
    capabilities: [],
  });
  const sessions = new RuntimeRegistry();
  sessions.setDb(db);
  const authority = new CanonicalConnectorRuntimeAuthorityResolver({
    owner: { kind: 'local_install', installationId: 'test' },
    sessions,
    mesh,
  });
  const service = new ConnectorRuntimePrincipalService({ db, authority });
  await service.initializeBoot();
  const opens = vi.spyOn(service, 'openTurn');
  const sidecar = scriptedSidecar(desk);
  const runtime = new OpenCodeRuntime({
    provider: { getClient: async () => sidecar.sdk, peekClient: () => sidecar.sdk },
    sessionMap: new OpenCodeSessionMap(db),
    modelDirectory: home,
  });
  sessions.register(runtime);
  runtime.setSessionSettings(sessions);
  runtime.setMeshCore(mesh);
  runtime.setConnectorRuntimeTools({
    principals: service,
    listenerUrl: 'http://127.0.0.1:1/connections',
    agentToolsUrl: 'http://127.0.0.1:1/agent',
    isConnectorCapabilityId: isConnectorRuntimeCapabilityId,
  });
  await sessions.persistSessionRuntime('s1', 'opencode', { kind: 'interactive' }, home);
  const streams: AsyncGenerator<StreamEvent>[] = [];
  const runs: Promise<unknown>[] = [];
  const makeStream = (opts?: MessageOpts) => {
    const stream = runtime.sendMessage('s1', 'owned turn', { cwd: desk, forAgent: home, ...opts });
    streams.push(stream);
    return stream;
  };
  const start = async (
    opts?: MessageOpts,
    observe?: (event: StreamEvent) => void | Promise<void>
  ) => {
    const count = sidecar.client.session.promptAsync.mock.calls.length;
    const events: StreamEvent[] = [];
    const stream = makeStream(opts);
    const finished = (async () => {
      for await (const event of stream) {
        events.push(event);
        await observe?.(event);
      }
    })();
    runs.push(finished);
    await Promise.race([
      vi.waitFor(() => expectPrompt(count)),
      finished.then(() => {
        throw new Error('Turn ended before SDK prompt');
      }),
    ]);
    return { events, finished, stream };
  };
  const expectPrompt = (count: number) => {
    if (sidecar.client.session.promptAsync.mock.calls.length <= count)
      throw new Error('SDK prompt has not started');
  };
  async function caller(index = opens.mock.results.length - 1) {
    const opened = await opens.mock.results[index]!.value;
    const resolved = await service.resolve({
      bearer: opened.bearer,
      expectedRuntime: 'opencode',
      expectedCanonicalCwd: opens.mock.calls[index]![0].canonicalCwd,
    });
    if (resolved.status !== 'resolved') throw new Error('Expected current canonical principal');
    return service.resolveToolTurn(resolved.principal);
  }
  const nativeId = async () =>
    (await sidecar.client.session.create.mock.results.at(-1)!.value).data.id;
  return {
    home,
    desk,
    db,
    mesh,
    sessions,
    service,
    runtime,
    sidecar,
    opens,
    start,
    makeStream,
    caller,
    nativeId,
    async finish() {
      sidecar.emit(sessionIdle(await nativeId()));
    },
    async close() {
      const failures: unknown[] = [];
      const cleanup = async (action: () => unknown) => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      };
      await cleanup(() => runtime.endSessionsWhere(() => true));
      for (const stream of streams) await cleanup(() => stream.return(undefined));
      await Promise.allSettled(runs);
      await cleanup(() => sidecar.end());
      await cleanup(() => mesh.close());
      await cleanup(() => db.$client.close());
      resetAgentIdentityService();
      clearTestHomes();
      await cleanup(() => rm(home, { recursive: true, force: true }));
      if (failures.length) throw new AggregateError(failures, 'Owned fixture cleanup failed');
    },
  };
}
