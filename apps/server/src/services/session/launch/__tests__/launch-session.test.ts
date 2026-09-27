/**
 * The launch service's own contract, beyond what the session route tests
 * already pin through HTTP: every refusal starts and writes nothing, the
 * caller's origin reaches the binding write untouched, and a caller's
 * `onSettled` hears how the detached turn ended.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';

vi.mock('../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    has: vi.fn(() => true),
    getDefaultType: vi.fn(() => 'claude-code'),
    persistSessionRuntime: vi.fn(async () => true),
    resolveForSession: vi.fn(async () => ({ getCapabilities: () => ({}) })),
  },
}));
vi.mock('../../../core/usage-reporter.js', () => ({ reportUsageEvent: vi.fn() }));
vi.mock('../../../workspace/room-session-place.js', () => ({
  resolveSessionCwdWithRoom: vi.fn(async () => ({ rung: 'default', cwd: '/default' })),
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => null) }));
vi.mock('../../session-state-projector.js', () => ({
  getOrCreateProjector: vi.fn(() => ({ cwd: undefined })),
}));
vi.mock('../../projector-persistence.js', () => ({ persistenceModeFor: vi.fn(() => 'none') }));
vi.mock('../../../observability/dispatch-buffers.js', () => ({
  recordDispatchStart: vi.fn(),
  recordDispatchEnd: vi.fn(),
}));
vi.mock('../../message-dispatcher.js', () => ({
  dispatchMessage: vi.fn(async () => ({
    canonicalId: 'canon-1',
    outcome: { kind: 'started', messageId: 'm-1' },
    queued: false,
    queuePosition: 0,
  })),
}));

import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { dispatchMessage } from '../../message-dispatcher.js';
import { recordDispatchEnd } from '../../../observability/dispatch-buffers.js';
import { resolveSessionCwdWithRoom } from '../../../workspace/room-session-place.js';
import { dispatchSessionMessage, isSessionLaunchRefusal } from '../launch-session.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';

const SESSION = '11111111-1111-4111-8111-111111111111';

/** A Mesh that knows exactly one agent directory. */
const mesh = {
  listWithPaths: () => [{ projectPath: '/agents/known' }],
} as unknown as MeshCore;

describe('dispatchSessionMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runtimeRegistry.has).mockReturnValue(true);
  });

  it('refuses an agent directory Mesh does not know, and starts nothing', async () => {
    const result = await dispatchSessionMessage({
      sessionId: SESSION,
      request: { content: 'hi', agentPath: '/agents/stranger' },
      clientId: 'c',
      meshCore: mesh,
      roomSessionPlace: undefined,
      origin: { kind: 'agent-launch' },
    });

    expect(result).toEqual({
      refused: 'INVALID_AGENT_PATH',
      message: 'Choose a registered agent before starting this session',
    });
    expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('refuses any agent directory while Mesh is not running', async () => {
    const result = await dispatchSessionMessage({
      sessionId: SESSION,
      request: { content: 'hi', agentPath: '/agents/known' },
      clientId: 'c',
      meshCore: undefined,
      roomSessionPlace: undefined,
      origin: { kind: 'interactive' },
    });

    expect(isSessionLaunchRefusal(result) && result.refused).toBe('INVALID_AGENT_PATH');
  });

  it('refuses an unregistered runtime before binding the session', async () => {
    vi.mocked(runtimeRegistry.has).mockReturnValue(false);

    const result = await dispatchSessionMessage({
      sessionId: SESSION,
      request: { content: 'hi', runtime: 'nope' },
      clientId: 'c',
      meshCore: mesh,
      roomSessionPlace: undefined,
      origin: { kind: 'interactive' },
    });

    expect(result).toEqual({ refused: 'UNKNOWN_RUNTIME', message: 'Unknown runtime: nope' });
    expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('binds the session with the origin its caller named', async () => {
    const result = await dispatchSessionMessage({
      sessionId: SESSION,
      request: { content: 'hi', agentPath: '/agents/known' },
      clientId: 'c',
      meshCore: mesh,
      roomSessionPlace: undefined,
      origin: { kind: 'agent-launch' },
    });

    expect(isSessionLaunchRefusal(result)).toBe(false);
    expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(
      SESSION,
      'claude-code',
      { kind: 'agent-launch' },
      '/agents/known'
    );
  });

  it("tells the caller's onSettled how the turn ended, after the dispatch buffer", async () => {
    const onSettled = vi.fn();
    await dispatchSessionMessage({
      sessionId: SESSION,
      request: { content: 'hi' },
      clientId: 'c',
      meshCore: mesh,
      roomSessionPlace: undefined,
      origin: { kind: 'interactive' },
      onSettled,
    });

    const passed = vi.mocked(dispatchMessage).mock.calls[0][0];
    passed.onSettled?.('failed');

    expect(recordDispatchEnd).toHaveBeenCalledWith(expect.any(String), 'failed');
    expect(onSettled).toHaveBeenCalledWith('failed');
    expect(vi.mocked(recordDispatchEnd).mock.invocationCallOrder[0]).toBeLessThan(
      onSettled.mock.invocationCallOrder[0]
    );
  });

  describe('where a turn may stand (spec `agent-home-desk` I3)', () => {
    afterEach(() => clearTestHomes());

    it('refuses a room conversation its runtime keeps in the room`s files, and starts nothing', async () => {
      // An OpenCode session from before room turns moved home: the room answers
      // that it cannot continue. Its transcript is untouched — only this turn
      // is refused. Seeded: dropping the refusal check reddens this.
      vi.mocked(resolveSessionCwdWithRoom).mockResolvedValueOnce({
        cwd: '/dork/rooms/r1/worktrees/ana-1',
        rung: 'explicit',
        forAgent: '/agents/known',
        refusal: { code: 'ROOM_SESSION_MOVED', message: 'Carry on in the room.' },
      });

      const result = await dispatchSessionMessage({
        sessionId: SESSION,
        request: { content: 'hi' },
        clientId: 'c',
        meshCore: mesh,
        roomSessionPlace: undefined,
        origin: { kind: 'interactive' },
      });

      expect(result).toEqual({ refused: 'ROOM_SESSION_MOVED', message: 'Carry on in the room.' });
      expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
      expect(dispatchMessage).not.toHaveBeenCalled();
    });

    it('refuses any launch whose folder is inside the rooms directory, whatever named it', async () => {
      // A session no room answers for, sent with a room's folder as its cwd.
      // Nothing that runs in a turn's folder — the per-turn git status, a hook,
      // the agent's shell — may run there. Seeded: dropping the rooms-dir check
      // reddens this.
      registerTestHomes([], { roomsDir: '/dork/rooms' });
      for (const cwd of ['/dork/rooms/r1/repo', '/dork/rooms/r1/worktrees/ana-1/src']) {
        vi.mocked(resolveSessionCwdWithRoom).mockResolvedValueOnce({ cwd, rung: 'explicit' });

        const result = await dispatchSessionMessage({
          sessionId: SESSION,
          request: { content: 'hi', cwd },
          clientId: 'c',
          meshCore: mesh,
          roomSessionPlace: undefined,
          origin: { kind: 'interactive' },
        });

        expect(isSessionLaunchRefusal(result) && result.refused, cwd).toBe('DESK_NOT_OWN');
      }
      expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
      expect(dispatchMessage).not.toHaveBeenCalled();
    });

    it('launches a folder outside the rooms directory as before', async () => {
      registerTestHomes([], { roomsDir: '/dork/rooms' });
      vi.mocked(resolveSessionCwdWithRoom).mockResolvedValueOnce({
        cwd: '/work/project',
        rung: 'explicit',
      });

      const result = await dispatchSessionMessage({
        sessionId: SESSION,
        request: { content: 'hi', cwd: '/work/project' },
        clientId: 'c',
        meshCore: mesh,
        roomSessionPlace: undefined,
        origin: { kind: 'interactive' },
      });

      expect(isSessionLaunchRefusal(result)).toBe(false);
      expect(dispatchMessage).toHaveBeenCalled();
    });
  });
});
