/**
 * Wiring for app-server transport tests: a real pool and transport over the
 * fake app-server host, with real thread keys and a recorded binding.
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { ConnectorThreadKeyRegistry } from '../../../connectors/principal/thread-keys.js';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import type { CreditsRelay } from '../../../core/cloud/credits-relay.js';
import { CodexAppServerPool } from '../app-server/process-pool.js';
import { AppServerCodexTransport } from '../transport/app-server-transport.js';
import type { CodexTurnRequest } from '../transport/codex-transport.js';
import { createCodexEventContext } from '../event-mapper.js';
import { FakeAppServerHost } from './fake-app-server.js';

/** The person's home the harness runs on. */
export const PERSON_HOME = '/fake/person/.codex';
/** The credits home the harness runs on (matches nothing on disk). */
export const CREDITS_ENV_HOME = '/fake/credits';

/** Options for {@link makeAppServerHarness}. */
export interface AppServerHarnessOptions {
  /** Wire connector tools (and thread keys). */
  withConnectorTools?: boolean;
  /** Provide a credits relay. */
  relay?: CreditsRelay;
  /** Stop-ack bound. */
  stopAckMs?: number;
}

/**
 * Build a pool and transport over a fake host.
 *
 * @param options - What to wire.
 */
export function makeAppServerHarness(options: AppServerHarnessOptions = {}) {
  const host = new FakeAppServerHost();
  const pool = new CodexAppServerPool({ spawn: host.spawn, timing: { shutdownStepMs: 20 } });
  const threadKeys = new ConnectorThreadKeyRegistry();
  const tools = options.withConnectorTools
    ? ({
        principals: {} as ConnectorRuntimeTools['principals'],
        threadKeys,
        listenerUrl: 'http://127.0.0.1:9999/mcp',
        agentToolsUrl: 'http://127.0.0.1:9999/agent',
        isConnectorCapabilityId: () => false,
      } satisfies ConnectorRuntimeTools)
    : undefined;
  const transport = new AppServerCodexTransport({
    pool,
    connectorTools: () => tools,
    ...(options.relay ? { creditsRelay: () => options.relay } : {}),
    environment: {
      person: () => ({ PATH: '/usr/bin', CODEX_HOME: PERSON_HOME }),
      credits: () => ({ PATH: '/usr/bin', CODEX_HOME: CREDITS_ENV_HOME }),
    },
    realpath: (path) => `/real${path}`,
    stopAckMs: options.stopAckMs ?? 300,
  });
  const bindings: Array<{ sessionId: string; threadId: string; replaces?: string }> = [];

  /** A turn request with sensible defaults. */
  const request = (
    overrides: Partial<CodexTurnRequest> & { sessionId: string }
  ): CodexTurnRequest => ({
    binary: '/opt/codex',
    boundThreadId: undefined,
    cwd: '/project',
    settings: { permissionMode: 'default' },
    writableDirectories: [],
    prompt: 'hello',
    launch: { home: 'person' },
    tools: {
      agentTokenEnv: {},
      managed: { servers: {}, env: {} },
      dorkosTools: null,
      connectorTools: null,
    },
    signal: new AbortController().signal,
    events: createCodexEventContext(overrides.sessionId),
    onThreadBound: (threadId, replaces) =>
      bindings.push({
        sessionId: overrides.sessionId,
        threadId,
        ...(replaces ? { replaces } : {}),
      }),
    ...overrides,
  });

  /** Drain a turn. */
  const run = async (turn: CodexTurnRequest): Promise<StreamEvent[]> => {
    const events: StreamEvent[] = [];
    for await (const event of transport.runTurn(turn)) events.push(event);
    return events;
  };

  return { host, pool, transport, threadKeys, tools, bindings, request, run };
}
