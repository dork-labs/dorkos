import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi, type MockInstance } from 'vitest';
import type { Db } from '@dorkos/db';
import type { FakeCodexHome } from '../fake-app-server.js';
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
import { CodexRuntime } from '../../codex-runtime.js';
import { CodexThreadMap } from '../../thread-map.js';
import { makeAppServerHarness, PERSON_HOME } from '../app-server-harness.js';
import type { RuntimeToolCaller } from '../../../../connectors/runtime-principal-port.js';

interface ToolTurnFixture {
  home: string;
  desk: string;
  db: Db;
  h: ReturnType<typeof makeAppServerHarness>;
  runtime: CodexRuntime;
  service: ConnectorRuntimePrincipalService;
  sessions: RuntimeRegistry;
  mesh: MeshCore;
  server: FakeCodexHome;
  opens: MockInstance<ConnectorRuntimePrincipalService['openTurn']>;
  caller(index?: number): Promise<RuntimeToolCaller>;
  callers: RuntimeToolCaller[];
  close(): Promise<void>;
}

/** Actual runtime, canonical SQLite principal and real JSON-RPC transport over an in-memory host. */
export async function toolTurnFixture(failBinary = false): Promise<ToolTurnFixture> {
  const home = await mkdtemp(path.join(tmpdir(), 'codex-tool-turn-'));
  initConfigManager(path.join(home, 'test-config'));
  const desk = path.join(home, 'worktree');
  await mkdir(desk);
  registerTestHomes([home], { managed: { [desk]: home } });
  const db = createTestDb();
  initAgentIdentityService(db);
  const mesh = new MeshCore({ db, defaultScanRoot: home, logger: noopLogger });
  await mesh.registerByPath(home, {
    name: 'Tool turn fixture',
    runtime: 'codex',
    capabilities: [],
  });
  const sessions = new RuntimeRegistry();
  sessions.setDb(db);
  const authority = new CanonicalConnectorRuntimeAuthorityResolver({
    owner: { kind: 'local_install', installationId: 'test' },
    sessions,
    mesh,
  });
  const h = makeAppServerHarness({ withConnectorTools: true });
  const service = new ConnectorRuntimePrincipalService({ db, authority, threadKeys: h.threadKeys });
  await service.initializeBoot();
  h.tools!.principals = service;
  const opens = vi.spyOn(service, 'openTurn');
  const runtime = new CodexRuntime({
    transport: h.transport,
    threadMap: new CodexThreadMap(db),
    resolveBinary: async () => {
      if (failBinary) throw new Error('owned setup failure');
      return '/fake/codex';
    },
    defaultCwd: home,
  });
  sessions.register(runtime);
  runtime.setSessionSettings(sessions);
  await sessions.persistSessionRuntime('s1', 'codex', { kind: 'interactive' }, home);
  runtime.setMeshCore(mesh);
  runtime.setConnectorRuntimeTools(h.tools!);
  const server = h.host.home(PERSON_HOME);
  const callers: RuntimeToolCaller[] = [];
  async function caller(index = opens.mock.results.length - 1) {
    const opened = await opens.mock.results[index]!.value;
    const resolved = await service.resolve({
      bearer: opened.bearer,
      expectedRuntime: 'codex',
      expectedCanonicalCwd: opens.mock.calls[index]![0].canonicalCwd,
    });
    if (resolved.status !== 'resolved') throw new Error('Expected live runtime principal');
    const c = await service.resolveToolTurn(resolved.principal);
    callers.push(c);
    return c;
  }
  return {
    home,
    desk,
    db,
    h,
    runtime,
    service,
    sessions,
    mesh,
    server,
    opens,
    caller,
    callers,
    async close() {
      await runtime.shutdown();
      await h.pool.shutdown();
      mesh.close();
      db.$client.close();
      resetAgentIdentityService();
      clearTestHomes();
      await rm(home, { recursive: true, force: true });
    },
  };
}
