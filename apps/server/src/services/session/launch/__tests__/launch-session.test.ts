/**
 * The launch service's own contract, beyond what the session route tests
 * already pin through HTTP: the two refusals start and write nothing, the
 * caller's origin reaches the binding write untouched, and a caller's
 * `onSettled` hears how the detached turn ended.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
vi.mock('../../../workspace/room-session-cwd.js', () => ({
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
import { dispatchSessionMessage, isSessionLaunchRefusal } from '../launch-session.js';

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
});
