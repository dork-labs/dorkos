/**
 * Where a door to an agent leads (DOR-3074): its Direct chat for the owner,
 * and its latest chat for anyone the server refuses one to.
 */
import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { agentChatTarget } from '../lib/agent-chat-target';

const AGENT = '/agents/scout';

/** A refusal the way the transport reports one. */
function refused(status: number): Error {
  return Object.assign(new Error('refused'), { status });
}

function deps(transport = createMockTransport()) {
  return { queryClient: new QueryClient(), transport };
}

describe('agentChatTarget', () => {
  it('opens the agent’s Direct chat for the owner', async () => {
    const transport = createMockTransport({
      openDirectChat: vi.fn().mockResolvedValue({
        sessionId: 'direct',
        sessionIds: ['direct'],
        roomId: 'dm',
        agentPath: AGENT,
      }),
    });

    const target = await agentChatTarget(deps(transport), AGENT, { runtime: 'codex' });

    expect(target?.search).toMatchObject({ session: 'direct', draft: '1', runtime: 'codex' });
    expect(transport.openDirectChat).toHaveBeenCalledWith({ agentPath: AGENT });
  });

  it('opens the agent’s latest chat for anyone the server refuses a Direct chat', async () => {
    const transport = createMockTransport({
      openDirectChat: vi.fn().mockRejectedValue(refused(403)),
      listSessions: vi
        .fn()
        .mockResolvedValue({ sessions: [{ id: 'latest', cwd: AGENT, title: 'Ship it' }] }),
    });

    const target = await agentChatTarget(deps(transport), AGENT);

    expect(target?.search).toEqual({ session: 'latest' });
  });

  it('starts a fresh chat there when the agent has none with them yet', async () => {
    const transport = createMockTransport({
      openDirectChat: vi.fn().mockRejectedValue(refused(403)),
      listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    });

    const target = await agentChatTarget(deps(transport), AGENT);

    expect(target?.search).toMatchObject({ draft: '1' });
    expect(target?.search.session).toEqual(expect.any(String));
  });

  it('passes on any other failure for the caller to report', async () => {
    const transport = createMockTransport({
      openDirectChat: vi.fn().mockRejectedValue(refused(500)),
    });

    await expect(agentChatTarget(deps(transport), AGENT)).rejects.toMatchObject({ status: 500 });
  });
});
