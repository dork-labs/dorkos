/**
 * The shared chat-place resolver owns the established-session cwd ladder and
 * the room-aware agent/default rungs used by both ordinary sends and boot rearm.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';

import { resolveChatPlace, type ResolveChatPlaceDeps } from '../resolve-chat-place.js';

const SESSION = 'chat-place-session';
const AGENT = '/agents/beta';

let runtime: FakeAgentRuntime & { findSession: NonNullable<AgentRuntime['findSession']> };
let deps: ResolveChatPlaceDeps;

beforeEach(() => {
  runtime = Object.assign(new FakeAgentRuntime('place-test'), {
    findSession: vi.fn(async () => null),
  });
  deps = {
    resolveSession: vi.fn(async () => ({ runtime, bound: true })),
    nativeSessionCwd: vi.fn(() => null),
    resolveWithRoom: vi.fn(async (request) =>
      request.cwd !== undefined
        ? { cwd: request.cwd, rung: 'explicit' as const }
        : request.agentPath !== undefined
          ? { cwd: request.agentPath, rung: 'agent-home' as const }
          : { cwd: '/default', rung: 'default' as const }
    ),
  };
});

describe('resolveChatPlace cwd precedence', () => {
  it('uses the bound runtime cwd before native and discovered folders', async () => {
    runtime.getSessionCwd = vi.fn(() => '/runtime');
    vi.mocked(runtime.findSession).mockResolvedValue({ cwd: '/discovered' } as never);
    vi.mocked(deps.nativeSessionCwd).mockReturnValue('/native');

    const result = await resolveChatPlace({ sessionId: SESSION, agentPath: AGENT }, deps);

    expect(result).toMatchObject({ cwd: '/runtime' });
    expect(deps.nativeSessionCwd).not.toHaveBeenCalled();
    expect(runtime.findSession).not.toHaveBeenCalled();
  });

  it('uses the native binding before runtime discovery', async () => {
    runtime.getSessionCwd = vi.fn(() => undefined);
    vi.mocked(runtime.findSession).mockResolvedValue({ cwd: '/discovered' } as never);
    vi.mocked(deps.nativeSessionCwd).mockReturnValue('/native');

    const result = await resolveChatPlace({ sessionId: SESSION, agentPath: AGENT }, deps);

    expect(result).toMatchObject({ cwd: '/native' });
    expect(runtime.findSession).not.toHaveBeenCalled();
  });

  it('uses runtime discovery before the agent-path rung', async () => {
    runtime.getSessionCwd = vi.fn(() => undefined);
    vi.mocked(runtime.findSession).mockResolvedValue({ cwd: '/discovered' } as never);

    const result = await resolveChatPlace({ sessionId: SESSION, agentPath: AGENT }, deps);

    expect(result).toMatchObject({ cwd: '/discovered' });
    expect(deps.resolveWithRoom).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/discovered', agentPath: AGENT }),
      undefined
    );
  });

  it('falls through to the agent path when the bound session has no folder', async () => {
    runtime.getSessionCwd = vi.fn(() => undefined);
    vi.mocked(runtime.findSession).mockResolvedValue(null);

    const result = await resolveChatPlace({ sessionId: SESSION, agentPath: AGENT }, deps);

    expect(result).toMatchObject({ cwd: AGENT, forAgent: undefined });
  });

  it('translates the default rung back to no cwd', async () => {
    vi.mocked(deps.resolveSession).mockResolvedValue({ runtime, bound: false });

    const result = await resolveChatPlace({ sessionId: SESSION }, deps);

    expect(result).toMatchObject({ cwd: undefined });
  });

  it('passes a room refusal through unchanged', async () => {
    vi.mocked(deps.resolveWithRoom).mockResolvedValue({
      cwd: AGENT,
      rung: 'explicit',
      refusal: { code: 'ROOM_SESSION_MOVED', message: 'Continue in the room.' },
    });

    const result = await resolveChatPlace({ sessionId: SESSION, agentPath: AGENT }, deps);

    expect(result).toEqual({
      refusal: { code: 'ROOM_SESSION_MOVED', message: 'Continue in the room.' },
    });
  });

  it('leaves an unbound workspace-keyed launch for the workspace branch', async () => {
    vi.mocked(deps.resolveSession).mockResolvedValue({ runtime, bound: false });

    const result = await resolveChatPlace(
      { sessionId: SESSION, cwd: '/source', agentPath: AGENT, workspaceKeyed: true },
      deps
    );

    expect(result).toMatchObject({ cwd: '/source' });
    expect(deps.resolveWithRoom).not.toHaveBeenCalled();
  });
});
