import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    resolveForSession: vi.fn(),
    getSessionAgentPath: vi.fn(),
  },
}));

vi.mock('../../../../lib/resolve-root.js', () => ({ DEFAULT_CWD: '/default/cwd' }));

import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { resolveAccountRootForSession } from '../resolve-session-account.js';

/** A claude-code runtime that can name a session's account. */
function accountAwareRuntime(accountRoot: string) {
  return {
    type: 'claude-code',
    accountRootForSession: vi.fn().mockResolvedValue(accountRoot),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('resolveAccountRootForSession', () => {
  it('asks the session’s own runtime, with that session’s working directory', async () => {
    // Purpose: the account is a property of the session, and the runtime that
    // owns it is the only thing that can run the ladder. The project dir has to
    // come along — it keys both the transcript probe and the agent manifest.
    const runtime = accountAwareRuntime('/Users/x/.claude2');
    vi.mocked(runtimeRegistry.resolveForSession).mockResolvedValue(runtime as never);
    vi.mocked(runtimeRegistry.getSessionAgentPath).mockResolvedValue('/repo/agent');

    const root = await resolveAccountRootForSession('session-1');

    expect(root).toBe('/Users/x/.claude2');
    expect(runtime.accountRootForSession).toHaveBeenCalledWith('session-1', '/repo/agent');
  });

  it('falls back to the default working directory when the session has no agent path', async () => {
    const runtime = accountAwareRuntime('/Users/x/.claude');
    vi.mocked(runtimeRegistry.resolveForSession).mockResolvedValue(runtime as never);
    vi.mocked(runtimeRegistry.getSessionAgentPath).mockResolvedValue(null);

    await resolveAccountRootForSession('session-1');

    expect(runtime.accountRootForSession).toHaveBeenCalledWith('session-1', '/default/cwd');
  });

  it('answers "no pin" for a runtime with no account concept', async () => {
    // Purpose: Codex and OpenCode have no config dirs to pin. Returning
    // undefined is what keeps the CLIENT out of that decision — it sends the
    // session id for every runtime and the server decides what it means.
    vi.mocked(runtimeRegistry.resolveForSession).mockResolvedValue({ type: 'codex' } as never);

    expect(await resolveAccountRootForSession('session-1')).toBeUndefined();
  });

  it('answers "no pin" rather than throwing when the session cannot be resolved', async () => {
    // Purpose: an unregistered runtime or a session with no binding row is not
    // worth refusing a sign-in over — it degrades to the behaviour the endpoint
    // had before a session could be named at all.
    vi.mocked(runtimeRegistry.resolveForSession).mockRejectedValue(new Error('not registered'));

    expect(await resolveAccountRootForSession('ghost')).toBeUndefined();
  });

  it('answers "no pin" when the runtime itself fails to resolve the account', async () => {
    const runtime = {
      type: 'claude-code',
      accountRootForSession: vi.fn().mockRejectedValue(new Error('unreadable manifest')),
    };
    vi.mocked(runtimeRegistry.resolveForSession).mockResolvedValue(runtime as never);
    vi.mocked(runtimeRegistry.getSessionAgentPath).mockResolvedValue('/repo/agent');

    expect(await resolveAccountRootForSession('session-1')).toBeUndefined();
  });
});
