/**
 * The launch service's own contract, beyond what the session route tests
 * already pin through HTTP: every refusal starts and writes nothing, the
 * caller's origin reaches the binding write untouched, and a caller's
 * `onSettled` hears how the detached turn ended.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';

vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundaryOrDorkHome: vi.fn(async () => {}),
}));
import { validateBoundaryOrDorkHome } from '../../../../lib/boundary.js';

const fakeRuntime = {
  type: 'claude-code',
  getSessionCwd: () => '/actual',
  getCapabilities: () => ({}),
  ensureSession: vi.fn(),
};

vi.mock('../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getNativeSessionCwd: vi.fn(() => null),
    computerRuntimeForAgentPath: vi.fn(() => undefined),
    has: vi.fn(() => true),
    getDefaultType: vi.fn(() => 'claude-code'),
    persistSessionRuntime: vi.fn(async () => true),
    resolveForSession: vi.fn(async () => fakeRuntime),
    resolveForSessionWithOwnership: vi.fn(async () => ({ runtime: fakeRuntime, bound: false })),
  },
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined) },
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
  onDispatchLifecycle: vi.fn(() => () => undefined),
}));

import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { configManager } from '../../../core/config-manager.js';
import { dispatchMessage } from '../../message-dispatcher.js';
import {
  chatHeardOutsider,
  messageTurnStarted,
  resetOutsiderTurns,
} from '../../origin/outsider-turns.js';
import { recordDispatchEnd } from '../../../observability/dispatch-buffers.js';
import { resolveSessionCwdWithRoom } from '../../../workspace/room-session-place.js';
import {
  AGENT_LAUNCH_MAX_LIVE,
  agentLaunchCapMessage,
  dispatchSessionMessage,
  isAgentLaunchCapFull,
  isSessionLaunchRefusal,
  resolveRuntimeTypeForNewSession,
} from '../launch-session.js';
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
    vi.mocked(runtimeRegistry.resolveForSessionWithOwnership).mockResolvedValue({
      runtime: fakeRuntime as never,
      bound: false,
    });
  });

  it('resumes an established session in its actual directory despite a stale supplied folder', async () => {
    vi.mocked(runtimeRegistry.resolveForSessionWithOwnership).mockResolvedValueOnce({
      runtime: fakeRuntime as never,
      bound: true,
    });
    vi.mocked(resolveSessionCwdWithRoom).mockImplementationOnce(async (request) => ({
      cwd: request.cwd!,
      rung: 'explicit',
    }));
    await dispatchSessionMessage({
      sessionId: SESSION,
      request: { content: 'continue', cwd: '/stale' },
      clientId: 'c',
      meshCore: undefined,
      roomSessionPlace: undefined,
      origin: { kind: 'interactive' },
    });
    expect(resolveSessionCwdWithRoom).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/actual' }),
      undefined
    );
    expect(dispatchMessage).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/actual' }));
    expect(validateBoundaryOrDorkHome).toHaveBeenCalledWith('/actual');
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
      message: 'Choose a registered agent before starting this chat',
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
    expect(onSettled).toHaveBeenCalledWith('failed', undefined);
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

  describe('the cap on sessions nobody typed into', () => {
    /** Launch one capped session, answering `accepted` as given. */
    function cappedLaunch(accepted = true, onSettled?: (o: 'ok' | 'failed') => void) {
      vi.mocked(dispatchMessage).mockResolvedValueOnce({
        accepted,
        canonicalId: 'canon',
        outcome: { kind: 'started', messageId: 'm' },
        queued: false,
        queuePosition: 0,
      } as never);
      return dispatchSessionMessage({
        sessionId: SESSION,
        request: { content: 'hi' },
        clientId: 'c',
        meshCore: mesh,
        roomSessionPlace: undefined,
        origin: { kind: 'agent-launch' },
        countsTowardLaunchCap: true,
        ...(onSettled ? { onSettled } : {}),
      });
    }

    /** Settle every capped turn still live, freeing the slots. */
    function settleAll(): void {
      for (const [opts] of vi.mocked(dispatchMessage).mock.calls) opts.onSettled?.('ok');
    }

    /** Answer `runtimes.maxAgentChats` as given, or leave it unset. */
    function setMaxAgentChats(value: number | undefined): void {
      vi.mocked(configManager.get).mockImplementation(((key: string) =>
        key === 'runtimes' && value !== undefined
          ? { maxAgentChats: value }
          : undefined) as typeof configManager.get);
    }

    afterEach(() => {
      settleAll();
      setMaxAgentChats(undefined);
    });

    it(`refuses the ${AGENT_LAUNCH_MAX_LIVE + 1}th live capped launch, and starts nothing for it`, async () => {
      for (let i = 0; i < AGENT_LAUNCH_MAX_LIVE; i++) {
        expect(isSessionLaunchRefusal(await cappedLaunch())).toBe(false);
      }
      expect(isAgentLaunchCapFull()).toBe(true);
      const calls = vi.mocked(dispatchMessage).mock.calls.length;

      expect(await cappedLaunch()).toEqual({
        refused: 'LAUNCH_CAP_FULL',
        message: agentLaunchCapMessage(),
      });
      expect(vi.mocked(dispatchMessage).mock.calls.length).toBe(calls);
    });

    it('still refuses the 9th at the shipped setting of 8', async () => {
      setMaxAgentChats(8);
      for (let i = 0; i < 8; i++) expect(isSessionLaunchRefusal(await cappedLaunch())).toBe(false);
      expect(isSessionLaunchRefusal(await cappedLaunch())).toBe(true);
    });

    it('admits a 9th once a person raises the setting, and refuses past the new number', async () => {
      setMaxAgentChats(12);
      for (let i = 0; i < 12; i++) expect(isSessionLaunchRefusal(await cappedLaunch())).toBe(false);
      const refused = await cappedLaunch();
      expect(refused).toEqual({ refused: 'LAUNCH_CAP_FULL', message: agentLaunchCapMessage() });
    });

    it('names the number in force and the setting that raises it', () => {
      setMaxAgentChats(12);
      expect(agentLaunchCapMessage()).toContain('(12)');
      expect(agentLaunchCapMessage()).toContain('runtimes.maxAgentChats');
    });

    it('frees a slot when a turn settles, and still tells the caller', async () => {
      const onSettled = vi.fn();
      await cappedLaunch(true, onSettled);
      for (let i = 1; i < AGENT_LAUNCH_MAX_LIVE; i++) await cappedLaunch();
      expect(isAgentLaunchCapFull()).toBe(true);

      vi.mocked(dispatchMessage).mock.calls[0]![0].onSettled?.('ok');

      expect(onSettled).toHaveBeenCalledWith('ok', undefined);
      expect(isAgentLaunchCapFull()).toBe(false);
    });

    it('frees the slot of a launch that was not accepted', async () => {
      for (let i = 0; i < AGENT_LAUNCH_MAX_LIVE; i++) await cappedLaunch(false);
      expect(isAgentLaunchCapFull()).toBe(false);
    });

    it('never counts or refuses a launch a person typed', async () => {
      for (let i = 0; i < AGENT_LAUNCH_MAX_LIVE; i++) await cappedLaunch();
      const result = await dispatchSessionMessage({
        sessionId: SESSION,
        request: { content: 'hi' },
        clientId: 'c',
        meshCore: mesh,
        roomSessionPlace: undefined,
        origin: { kind: 'interactive' },
      });
      expect(isSessionLaunchRefusal(result)).toBe(false);
    });
  });

  describe('an unattended launch', () => {
    it('marks only this turn unattended, never the session a person opens next', async () => {
      await dispatchSessionMessage({
        sessionId: SESSION,
        request: { content: 'hi', cwd: '/work/project' },
        clientId: 'c',
        meshCore: mesh,
        roomSessionPlace: undefined,
        origin: { kind: 'account-handoff' },
        unattended: true,
      });

      // A session created unattended would refuse every ask a person later
      // raises in it: the flag rides the turn instead.
      expect(fakeRuntime.ensureSession).not.toHaveBeenCalled();
      expect(vi.mocked(dispatchMessage).mock.calls[0]![0].unattended).toBe(true);
    });

    it('leaves an attended launch as it was', async () => {
      await dispatchSessionMessage({
        sessionId: SESSION,
        request: { content: 'hi' },
        clientId: 'c',
        meshCore: mesh,
        roomSessionPlace: undefined,
        origin: { kind: 'interactive' },
      });
      expect(fakeRuntime.ensureSession).not.toHaveBeenCalled();
      expect(vi.mocked(dispatchMessage).mock.calls[0]![0].unattended).toBeUndefined();
    });
  });
});

describe('a launch held by a continuation (DOR-3203)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOutsiderTurns();
    vi.mocked(runtimeRegistry.has).mockReturnValue(true);
    vi.mocked(runtimeRegistry.resolveForSessionWithOwnership).mockResolvedValue({
      runtime: fakeRuntime as never,
      bound: false,
    });
  });
  afterEach(() => resetOutsiderTurns());

  async function launched(extra: { continuationHold?: true }) {
    // Queued behind a running turn, so its note waits for the turn's start.
    vi.mocked(dispatchMessage).mockResolvedValueOnce({
      accepted: true,
      canonicalId: SESSION,
      outcome: { messageId: 'm-1', requested: 'queue', applied: 'queue' },
      queued: true,
      queuePosition: 1,
    } as never);
    await dispatchSessionMessage({
      sessionId: SESSION,
      request: { content: 'hi', cwd: '/work/project' },
      clientId: 'c',
      meshCore: mesh,
      roomSessionPlace: undefined,
      origin: { kind: 'account-resume' },
      permissionCeiling: 'runtime-default',
      ...extra,
    });
    const passed = vi.mocked(dispatchMessage).mock.calls[0]![0];
    messageTurnStarted(SESSION, passed.messageId!);
    return passed;
  }

  it('passes the hold on, and does not count the chat as one a stranger reached', async () => {
    const passed = await launched({ continuationHold: true });
    expect(passed).toMatchObject({ permissionCeiling: 'runtime-default', continuationHold: true });
    expect(chatHeardOutsider(SESSION)).toBe(false);
  });

  it('counts a Wi-Fi hold as a stranger’s, as before (DOR-3037)', async () => {
    const passed = await launched({});
    expect(passed.continuationHold).toBeUndefined();
    expect(chatHeardOutsider(SESSION)).toBe(true);
  });
});

describe('a message for a paused agent (spec audit-trail PR5)', () => {
  afterEach(async () => {
    const { resetAgentPause } = await import('../../../mesh/pause/agent-pause.js');
    resetAgentPause();
  });

  it('is refused with AGENT_PAUSED before anything is bound or queued, and recorded', async () => {
    const { initAgentPause } = await import('../../../mesh/pause/agent-pause.js');
    vi.clearAllMocks();
    vi.mocked(runtimeRegistry.resolveForSessionWithOwnership).mockResolvedValue({
      runtime: fakeRuntime as never,
      bound: false,
    });
    vi.mocked(resolveSessionCwdWithRoom).mockResolvedValueOnce({
      cwd: '/agents/known',
      rung: 'explicit',
    });
    const pausedAgentOfTurn = vi.fn(() => ({ id: 'agent-1', name: 'Scout' }));
    const recordHeld = vi.fn();
    initAgentPause({ pausedAgentOfTurn, recordHeld } as never);

    const result = await dispatchSessionMessage({
      sessionId: SESSION,
      request: { content: 'hi', cwd: '/agents/known' },
      clientId: 'c',
      meshCore: mesh,
      roomSessionPlace: undefined,
      origin: { kind: 'interactive' },
    });

    expect(result).toEqual({
      refused: 'AGENT_PAUSED',
      message: 'Scout is paused.',
      agentId: 'agent-1',
    });
    expect(pausedAgentOfTurn).toHaveBeenCalledWith({ cwd: '/agents/known' });
    expect(recordHeld).toHaveBeenCalledWith(
      { id: 'agent-1', name: 'Scout' },
      { via: 'message', sessionId: SESSION }
    );
    expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();
  });
});

it('retained computer placement refuses an explicit host runtime hint', async () => {
  vi.mocked(runtimeRegistry.computerRuntimeForAgentPath).mockReturnValueOnce('computer-local');
  await expect(
    resolveRuntimeTypeForNewSession({ agentPath: '/computer', runtimeHint: 'opencode' })
  ).rejects.toThrow('COMPUTER_RUNTIME_MISMATCH');
  vi.mocked(runtimeRegistry.computerRuntimeForAgentPath).mockReturnValueOnce('computer-local');
  await expect(resolveRuntimeTypeForNewSession({ agentPath: '/computer' })).resolves.toBe(
    'computer-local'
  );
});
