/**
 * Security's proof (review `agent-identity-extension-calls`, 2026-11-01),
 * inverted (DOR-3644): an agent that names another agent's folder or chat
 * through the launch service is refused before anything is written, and a
 * refusal leaves an audit row naming who asked.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';

vi.mock('../../../../lib/boundary.js', () => ({
  // The protected-folder rule finds the home folder through this (DOR-4060).
  expandTilde: (p: string) => (p === '~' ? (process.env.HOME ?? '/') : p),
  validateBoundaryOrDorkHome: vi.fn(async () => {}),
}));

const fakeRuntime = {
  type: 'claude-code',
  getSessionCwd: vi.fn((): string | undefined => '/actual'),
  getCapabilities: () => ({}),
  ensureSession: vi.fn(),
};

vi.mock('../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getNativeSessionCwd: vi.fn(() => null),
    computerRuntimeForAgentPath: vi.fn(() => undefined),
    has: vi.fn(() => true),
    get: vi.fn(() => fakeRuntime),
    getDefaultType: vi.fn(() => 'claude-code'),
    persistSessionRuntime: vi.fn(async () => true),
    resolveForSession: vi.fn(async () => fakeRuntime),
    resolveForSessionWithOwnership: vi.fn(async () => ({ runtime: fakeRuntime, bound: false })),
    resolveSessionRuntime: vi.fn(async () => ({ bound: false })),
    getSessionAgentPath: vi.fn(async (): Promise<string | null> => null),
  },
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined) },
}));
vi.mock('../../../core/usage-reporter.js', () => ({ reportUsageEvent: vi.fn() }));
vi.mock('../../../workspace/room-session-place.js', () => ({
  resolveSessionCwdWithRoom: vi.fn(async (request: { cwd?: string }) =>
    request.cwd !== undefined ? { cwd: request.cwd, rung: 'explicit' } : { rung: 'default' }
  ),
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
    accepted: true,
    canonicalId: 'canon-1',
    outcome: { messageId: 'm-1', requested: 'queue', applied: 'queue' },
    queued: false,
    queuePosition: 0,
  })),
  onDispatchLifecycle: vi.fn(() => () => undefined),
}));
vi.mock('../../../audit/audit-trail.js', () => ({ recordAudit: vi.fn() }));

import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { dispatchMessage } from '../../message-dispatcher.js';
import { recordAudit } from '../../../audit/audit-trail.js';
import { dispatchSessionMessage, isSessionLaunchRefusal } from '../launch-session.js';
import type { SessionLauncher } from '../launch-caller.js';
import { resolveAgentHome } from '../../../core/agent-identity/index.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';

const SESSION = '11111111-1111-4111-8111-111111111111';

/** Two registered agents, A (the caller) and B. */
const twoAgents = {
  listWithPaths: () => [
    { id: 'id-a', projectPath: '/agents/a' },
    { id: 'id-b', projectPath: '/agents/b' },
  ],
} as unknown as MeshCore;

const AS_A: SessionLauncher = { kind: 'agent', agentPath: '/agents/a' };

function launch(request: { content: string; cwd?: string; agentPath?: string }) {
  return dispatchSessionMessage({
    sessionId: SESSION,
    request,
    clientId: 'c',
    meshCore: twoAgents,
    roomSessionPlace: undefined,
    origin: { kind: 'agent-launch' },
    launcher: AS_A,
  });
}

describe('an agent launch into another agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerTestHomes(['/agents/a', '/agents/b']);
    vi.mocked(runtimeRegistry.resolveForSessionWithOwnership).mockResolvedValue({
      runtime: fakeRuntime as never,
      bound: false,
    });
    vi.mocked(runtimeRegistry.getSessionAgentPath).mockResolvedValue(null);
  });
  afterEach(() => clearTestHomes());

  it("refuses cwd = B's home, and dispatches and writes nothing", async () => {
    const result = await launch({ content: 'call ext tool', cwd: '/agents/b' });
    expect(isSessionLaunchRefusal(result) && result.launcherRefused).toBe('OTHER_AGENTS_FOLDER');
    expect(dispatchMessage).not.toHaveBeenCalled();
    expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
  });

  it("refuses agentPath = B's home, though B is registered", async () => {
    const result = await launch({ content: 'hi', agentPath: '/agents/b', cwd: '/agents/b' });
    expect(isSessionLaunchRefusal(result) && result.launcherRefused).toBe('NOT_THE_CALLER');
    expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
  });

  it("refuses a message into B's existing chat, whatever folder it stands in", async () => {
    vi.mocked(runtimeRegistry.resolveForSessionWithOwnership).mockResolvedValue({
      runtime: fakeRuntime as never,
      bound: true,
    });
    fakeRuntime.getSessionCwd.mockReturnValueOnce('/projects/shared');
    vi.mocked(runtimeRegistry.getSessionAgentPath).mockResolvedValue('/agents/b');

    const result = await launch({ content: 'as B' });
    expect(isSessionLaunchRefusal(result) && result.launcherRefused).toBe('OTHER_AGENTS_CHAT');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('records the refusal, naming who asked', async () => {
    await launch({ content: 'x', cwd: '/agents/b' });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'session.launch',
        outcome: 'refused',
        error: 'OTHER_AGENTS_FOLDER',
        change: [
          { field: 'launchedBy', after: 'id-a' },
          { field: 'cwd', after: '/agents/b' },
        ],
      })
    );
  });

  it('binds its own home with who launched it, and records that', async () => {
    const result = await launch({ content: 'x', cwd: '/agents/a' });
    expect(isSessionLaunchRefusal(result)).toBe(false);
    expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(
      SESSION,
      'claude-code',
      { kind: 'agent-launch', launchedBy: 'id-a' },
      '/agents/a'
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session.launch', outcome: 'ok' })
    );
  });

  it('pins a chat it starts in a folder no agent owns to itself, so a swapped folder names nobody', async () => {
    const result = await launch({ content: 'x', cwd: '/projects/free' });
    expect(isSessionLaunchRefusal(result)).toBe(false);
    expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(
      SESSION,
      'claude-code',
      { kind: 'agent-launch', launchedBy: 'id-a' },
      '/agents/a'
    );
    expect(vi.mocked(dispatchMessage).mock.calls[0]![0].forAgent).toBe('/agents/a');
  });

  it("pins every later turn of A's chat to A, so a folder swapped to read as B names nobody", async () => {
    // A's chat, bound and recorded as A, in a folder that now reads as B's (a
    // forged worktree pointer, a swapped link; Security's M1 on #3417). The next
    // turn arrives the way a person's typing or a chat_send does: no launcher.
    registerTestHomes(['/agents/a', '/agents/b'], { managed: { '/projects/f': '/agents/b' } });
    vi.mocked(runtimeRegistry.resolveForSessionWithOwnership).mockResolvedValue({
      runtime: fakeRuntime as never,
      bound: true,
    });
    fakeRuntime.getSessionCwd.mockReturnValueOnce('/projects/f');
    vi.mocked(runtimeRegistry.getSessionAgentPath).mockResolvedValue('/agents/a');

    const result = await dispatchSessionMessage({
      sessionId: SESSION,
      request: { content: 'later turn' },
      clientId: 'c',
      meshCore: twoAgents,
      roomSessionPlace: undefined,
      origin: { kind: 'interactive' },
    });
    expect(isSessionLaunchRefusal(result)).toBe(false);
    const sent = vi.mocked(dispatchMessage).mock.calls[0]![0];
    expect(sent.forAgent).toBe('/agents/a');
    // What the turn's identity resolves to from there: nobody, never B.
    expect(resolveAgentHome(sent.cwd, sent.forAgent)).toEqual({
      kind: 'refused',
      reason: 'not-the-turns-agent',
    });
  });

  it('asks nothing of a launch the server places itself', async () => {
    const result = await dispatchSessionMessage({
      sessionId: SESSION,
      request: { content: 'beat', cwd: '/agents/b' },
      clientId: 'c',
      meshCore: twoAgents,
      roomSessionPlace: undefined,
      origin: { kind: 'heartbeat' } as never,
    });
    expect(isSessionLaunchRefusal(result)).toBe(false);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
