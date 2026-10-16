/**
 * @vitest-environment node
 *
 * The relay's live wiring: nothing is served before the server hands over its
 * pieces, an agent is a system agent unless its manifest says otherwise, and a
 * chat's records come from the server's own tables, with a chat outside the
 * boundary kept as existing but unplaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';

const { sessionExists, boundaryRefusal, resolveSessionCwdOrNull, runtime, runtimeRegistry } =
  vi.hoisted(() => {
    const runtime = {
      type: 'claude-code',
      getInternalSessionId: vi.fn((): string | undefined => undefined),
      getSession: vi.fn(),
    };
    return {
      sessionExists: vi.fn(),
      boundaryRefusal: vi.fn(),
      resolveSessionCwdOrNull: vi.fn(),
      runtime,
      runtimeRegistry: {
        resolveForSession: vi.fn(async () => runtime),
        getSessionAgentPath: vi.fn(async () => '/work/acme'),
        getSessionLaunchOrigin: vi.fn(() => 'interactive'),
      },
    };
  });

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../session/launch/session-exists.js', () => ({ sessionExists }));
vi.mock('../../../../lib/route-utils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  boundaryRefusal,
}));
vi.mock('../../../session/resolution/resolve-read-cwd.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSessionCwdOrNull,
}));
vi.mock('../../../session/resolution/session-settings-overlay.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSettingsKey: (id: string) => id,
}));
vi.mock('../../runtime-registry.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeRegistry,
}));

import { liveRelayDeps, type SessionRelayWiring } from '../live-deps.js';

const CHAT = '00000000-0000-4000-8000-000000000001';

function mesh(): MeshCore {
  const manifests: Record<string, { isSystem?: boolean } | undefined> = {
    a: {},
    b: { isSystem: true },
    c: undefined,
  };
  return {
    listWithPaths: () => [
      { id: 'a', name: 'a', projectPath: '/work/acme' },
      { id: 'b', name: 'b', projectPath: '/dork/agents/dorkbot' },
      { id: 'c', name: 'c', projectPath: '/work/gone' },
    ],
    get: (id: string) => manifests[id],
  } as unknown as MeshCore;
}

function wiring(over: Partial<SessionRelayWiring> = {}): SessionRelayWiring {
  return {
    meshCore: () => mesh(),
    origins: {
      resolveRoomOrigins: (ids) =>
        new Map(
          ids.filter((id) => id === 'room').map((id) => [id, { roomLabel: '#r', roomId: 'r' }])
        ),
    },
    roomSessionPlace: () => undefined,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionExists.mockResolvedValue(true);
  boundaryRefusal.mockResolvedValue(undefined);
  resolveSessionCwdOrNull.mockResolvedValue('/work/acme');
  runtime.getSession.mockResolvedValue(null);
});

describe('liveRelayDeps', () => {
  it('knows no agents before the server wires the relay', () => {
    expect(liveRelayDeps(() => null).agents()).toEqual([]);
  });

  it('treats an agent as a system agent unless its manifest says it is not', () => {
    const agents = liveRelayDeps(() => wiring()).agents();
    expect(agents.map((a) => [a.id, a.isSystem])).toEqual([
      ['a', false],
      ['b', true],
      ['c', true],
    ]);
  });

  it('answers null only for a chat that does not exist', async () => {
    sessionExists.mockResolvedValue(false);
    expect(await liveRelayDeps(() => wiring()).locateSession(CHAT)).toBeNull();
  });

  it('keeps a chat outside the boundary as existing but unplaced', async () => {
    boundaryRefusal.mockResolvedValue({ error: 'outside' });
    const facts = await liveRelayDeps(() => wiring()).locateSession(CHAT);
    expect(facts).toMatchObject({ sessionId: CHAT, cwd: null, row: null });
    expect(runtime.getSession).not.toHaveBeenCalled();
  });

  it('reads the chat’s records from the server’s own tables', async () => {
    const facts = await liveRelayDeps(() => wiring()).locateSession(CHAT);
    expect(facts).toEqual({
      sessionId: CHAT,
      cwd: '/work/acme',
      agentPath: '/work/acme',
      launchOrigin: 'interactive',
      row: null,
      ownedBy: { room: false, task: false, beat: false },
    });
  });
});
