import { createDb, runMigrations, type Db } from '@dorkos/db';
import { registerTestHomes } from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import type {
  RuntimeToolTurnFacts,
  OpenConnectorTurnInput,
  OpenConnectorTurnResult,
} from '../../runtime-principal-port.js';
import { CanonicalConnectorRuntimeAuthorityResolver } from '../runtime-authority-resolver.js';
import type { ServerPrincipalProof } from '../server-principal.js';
import { ConnectorThreadKeyRegistry } from '../thread-keys.js';
import { ConnectorRuntimePrincipalService } from '../runtime-principal-service.js';

interface LiveTurnFixture {
  db: Db;
  threadKeys: ConnectorThreadKeyRegistry;
  service: ConnectorRuntimePrincipalService;
  authority: CanonicalConnectorRuntimeAuthorityResolver;
  input: OpenConnectorTurnInput & { canonicalCwd: string };
  ownership: { isCurrent: () => boolean; readToolTurn: () => RuntimeToolTurnFacts | undefined };
  opened: OpenConnectorTurnResult;
  principal: ServerPrincipalProof;
  abort: AbortController;
  registry: ReturnType<typeof registerTestHomes>;
  home: string;
  facts: RuntimeToolTurnFacts | undefined;
  setCurrent(value: boolean): void;
  expire(): void;
  setRuntime(value: string): void;
  failSessionRead(error?: Error): void;
  setHome(value: string | null): void;
  setAgent(value: string): void;
}

/** Real SQLite bindings and canonical authority with explicit mutable external metadata. */
export async function liveTurnFixture(): Promise<LiveTurnFixture> {
  const db = createDb(':memory:');
  runMigrations(db);
  const home = '/test/live-tool-agent';
  const registry = registerTestHomes([home]);
  const abort = new AbortController();
  let current = true;
  let now = Date.parse('2026-11-17T12:00:00Z');
  let runtime = 'opencode';
  let sessionReadError: Error | undefined;
  let storedHome: string | null = home;
  let agentId = 'agent-a';
  let facts: RuntimeToolTurnFacts | undefined = {
    effectiveMode: 'careful',
    chosenMode: undefined,
    neverAsks: false,
    session: { eventQueue: [] },
    signal: abort.signal,
  };
  const authority = new CanonicalConnectorRuntimeAuthorityResolver({
    owner: { kind: 'local_install', installationId: 'install-a' },
    sessions: {
      resolveSessionRuntime: async () => {
        if (sessionReadError) throw sessionReadError;
        return { type: runtime, bound: true };
      },
      getSessionAgentPath: async () => storedHome,
    },
    mesh: { getByPath: (path) => (path === home ? { id: agentId } : undefined) },
  });
  const threadKeys = new ConnectorThreadKeyRegistry();
  const service = new ConnectorRuntimePrincipalService({
    threadKeys,
    db,
    authority,
    now: () => new Date(now),
    bindingTtlMs: 1000,
  });
  await service.initializeBoot();
  const input = {
    runtime: 'opencode' as const,
    canonicalSessionId: 'session-a',
    agentPath: home,
    canonicalCwd: '/test/desk',
    signal: abort.signal,
  };
  const ownership = { isCurrent: () => current, readToolTurn: () => facts };
  const opened = await service.openTurn(input, ownership);
  const resolved = await service.resolve({
    bearer: opened.bearer,
    expectedRuntime: input.runtime,
    expectedCanonicalCwd: input.canonicalCwd,
  });
  if (resolved.status !== 'resolved') throw new Error('Expected authentic fixture principal');
  return {
    db,
    threadKeys,
    service,
    authority,
    input,
    ownership,
    opened,
    principal: resolved.principal,
    abort,
    registry,
    home,
    get facts() {
      return facts;
    },
    set facts(value) {
      facts = value;
    },
    setCurrent(value: boolean) {
      current = value;
    },
    expire() {
      now += 1001;
    },
    failSessionRead(error?: Error) {
      sessionReadError = error;
    },
    setRuntime(value: string) {
      runtime = value;
    },
    setHome(value: string | null) {
      storedHome = value;
    },
    setAgent(value: string) {
      agentId = value;
    },
  };
}
