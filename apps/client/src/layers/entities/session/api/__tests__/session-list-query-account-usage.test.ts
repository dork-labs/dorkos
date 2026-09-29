import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMockAccountUsage, createMockTransport } from '@dorkos/test-utils';
import { accountKeys } from '@/layers/shared/model';
import { sessionListQueryOptions } from '../session-list-query';

describe('sessionListQueryOptions', () => {
  it('seeds each runtime’s account usage from the list envelope, with no usage request', async () => {
    const claude = createMockAccountUsage();
    const codex = createMockAccountUsage({ runtime: 'codex', accountId: 'default', label: null });
    const transport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({ sessions: [], accountUsage: [claude, codex] }),
    });
    const queryClient = new QueryClient();

    await sessionListQueryOptions({ transport, queryClient }, null).queryFn();

    expect(queryClient.getQueryData(accountKeys.usage('claude-code'))).toEqual([claude]);
    expect(queryClient.getQueryData(accountKeys.usage('codex'))).toEqual([codex]);
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });

  it('leaves the usage cache alone when the envelope carries no usage', async () => {
    const transport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    });
    const queryClient = new QueryClient();

    await sessionListQueryOptions({ transport, queryClient }, null).queryFn();

    expect(queryClient.getQueryData(accountKeys.usage('claude-code'))).toBeUndefined();
  });
});
