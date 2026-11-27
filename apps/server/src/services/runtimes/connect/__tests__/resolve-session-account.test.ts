import { describe, it, expect, vi, beforeEach } from 'vitest';
// Computer-side code reads agent facts through the port, wired as boot does.
import '../../../core/agent-identity/__tests__/wire-test-facts.js';

vi.mock('../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    getNativeSessionCwd: vi.fn(() => null),
    resolveForSession: vi.fn(),
    getSessionAgentPath: vi.fn(),
  },
}));

vi.mock('../../../../lib/resolve-root.js', () => ({ DEFAULT_CWD: '/default/cwd' }));

import { createTestDb } from '@dorkos/test-utils/db';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { setSessionAgentSources } from '../../../core/agent-identity/session-agent.js';
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

  // DOR-5038: a chat started in a folder from the command line records no agent.
  it('uses the folder the server holds for a chat that recorded no agent', async () => {
    const runtime = accountAwareRuntime('/Users/x/.claude3');
    vi.mocked(runtimeRegistry.resolveForSession).mockResolvedValue(runtime as never);
    vi.mocked(runtimeRegistry.getSessionAgentPath).mockResolvedValue(null);
    // The registry is stubbed in this file, so the chat's folder comes only from
    // the live lookup; `session-agent.test.ts` covers the real bound chat.
    setSessionAgentSources({
      db: createTestDb(),
      liveCwd: (id) => (id === 'session-1' ? '/work/project' : undefined),
    });
    try {
      await resolveAccountRootForSession('session-1');
    } finally {
      setSessionAgentSources(undefined);
    }

    expect(runtime.accountRootForSession).toHaveBeenCalledWith('session-1', '/work/project');
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
