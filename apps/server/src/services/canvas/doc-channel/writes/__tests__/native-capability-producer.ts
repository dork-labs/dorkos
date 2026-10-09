/** Test-only original Codex construction: replacing provider events cannot mint native principal authority. */
import { vi } from 'vitest';
import { agents, eq } from '@dorkos/db';
import { join } from 'node:path';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
  setAgentHomeRegistry,
} from '../../../../core/agent-identity/index.js';
import {
  CodexRuntime,
  sendCodexOriginalLockedMessage,
} from '../../../../runtimes/codex/codex-runtime.js';
import { disposeProjector } from '../../../../session/session-state-projector.js';
import { CodexThreadMap } from '../../../../runtimes/codex/thread-map.js';
import type {
  nativeRoomAuthorityFixture,
  NativeRoomCodexObservation,
} from './authority-fixtures.js';

/** Open one genuine original producer over an already-created SAME native fixture and retain its active scope. */
export async function startNativeCodexCapabilityProducer(
  h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>>,
  observed: NativeRoomCodexObservation
) {
  if (h.originalTarget.runtime !== 'codex')
    throw new Error('Original Codex fixture runtime required');
  const { agentId, agentPath, canonicalSessionId: sessionId } = h.originalTarget;
  initAgentIdentityService(h.db);
  const runtime = new CodexRuntime({
    transport: 'exec',
    threadMap: new CodexThreadMap(h.db),
    resolveBinary: async () => '/bin/codex',
    defaultCwd: agentPath,
  });
  const mesh = {
    getByPath: (path: string) => {
      const row = h.db.select().from(agents).where(eq(agents.id, agentId)).get();
      return row?.status === 'active' && row.projectPath === path
        ? { id: row.id, name: row.name }
        : undefined;
    },
    updateLastSeen: () => {},
    listWithPaths: () =>
      h.db
        .select()
        .from(agents)
        .where(eq(agents.status, 'active'))
        .all()
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          projectPath: agent.projectPath,
          ...(agent.displayName === null ? {} : { displayName: agent.displayName }),
          ...(agent.icon === null ? {} : { icon: agent.icon }),
          ...(agent.color === null ? {} : { color: agent.color }),
        })),
  };
  runtime.setMeshCore(mesh);
  // Match the original bootstrap: identity resolution reads the registered
  // native agent rows, rather than treating arbitrary cwd/manifest DATA as a home.
  setAgentHomeRegistry({
    isRegisteredHome: (dir) => mesh.getByPath(dir) !== undefined,
    listRegisteredHomes: () => mesh.listWithPaths().map((agent) => agent.projectPath),
    managedWorkspaceOwner: () => null, // This fixture creates no managed workspace.
    roomsDir: join(h.dir, 'rooms'),
  });
  runtime.setConnectorRuntimeTools({
    principals: h.principals,
    listenerUrl: 'http://127.0.0.1:4341/mcp',
    agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
    isConnectorCapabilityId: (id) => id.startsWith('connectors.'),
  });
  const holder = { on: () => {} },
    beforeOptions = observed.options.length,
    beforePrompts = observed.prompts.length;
  if (!runtime.acquireLock(sessionId, 'native-capability-producer', holder))
    throw new Error('Original native producer lock unavailable');
  const stream = sendCodexOriginalLockedMessage(
    runtime,
    sessionId,
    'actual native capability producer',
    { cwd: agentPath },
    holder,
    sessionId
  );
  if (!stream) throw new Error('Original native producer missing');
  let ended = false,
    producerFailed = false,
    producerCause: unknown;
  const done = (async () => {
    try {
      for await (const _ of stream) {
      }
    } catch (cause) {
      producerFailed = true;
      producerCause = cause;
      throw cause;
    } finally {
      ended = true;
    }
  })();
  void done.catch(() => {}); // Preserve rejection for owned close while preventing an unobserved setup rejection.
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (cause: unknown) => void;
    closing = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    void (async () => {
      let failed = false,
        first: unknown;
      const attempt = async (work: () => unknown | Promise<unknown>) => {
        try {
          await work();
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      };
      await attempt(() => observed.releaseProducer());
      await attempt(() => stream.return(undefined));
      await attempt(() => done);
      await attempt(() => runtime.releaseLock(sessionId, 'native-capability-producer'));
      await attempt(() => disposeProjector(sessionId));
      await attempt(() => resetAgentIdentityService());
      await attempt(() => setAgentHomeRegistry(undefined));
      if (failed) throw first;
    })().then(resolve, reject);
    return closing;
  };
  const originalFixtureCleanup = h.cleanup;
  // Retain the real fixture until this original source has positively retired, including failed setup.
  h.cleanup = async () => {
    await close();
    await originalFixtureCleanup();
  };
  try {
    await vi.waitFor(() => {
      if (producerFailed) throw producerCause;
      if (
        ended ||
        observed.options.length <= beforeOptions ||
        observed.prompts.length <= beforePrompts
      )
        throw new Error('Original native producer is not active');
    });
    // Binary/model discovery can construct an earlier SDK client without turn
    // credentials. The active producer's prompt follows its final turn client.
    const options = observed.options.at(-1);
    const envDescriptor =
      options && typeof options === 'object'
        ? Object.getOwnPropertyDescriptor(options, 'env')
        : undefined;
    const env = envDescriptor && 'value' in envDescriptor ? envDescriptor.value : undefined;
    const authDescriptor =
      env && typeof env === 'object'
        ? Object.getOwnPropertyDescriptor(env, 'DORKOS_CONNECTOR_MCP_AUTHORIZATION')
        : undefined;
    const authorization =
      authDescriptor && 'value' in authDescriptor ? authDescriptor.value : undefined;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
      throw new Error('Actual native SDK bearer missing');
    const resolved = await h.principals.resolve({
      bearer: authorization.slice(7),
      expectedRuntime: 'codex',
      expectedCanonicalCwd: agentPath,
    });
    if (resolved.status !== 'resolved' || ended)
      throw new Error('Original active native principal missing');
    return {
      runtime,
      context: {
        serverPrincipal: resolved.principal,
        sessionId,
        cwd: agentPath,
        mcpServer: 'in-session' as const,
      },
      close,
    };
  } catch (cause) {
    try {
      await close();
    } catch {}
    throw cause;
  }
}
