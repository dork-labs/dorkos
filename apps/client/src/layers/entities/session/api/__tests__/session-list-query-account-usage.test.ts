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

// Originating-occurrence controls preserve the captured request and publication boundary.
it('refuses owned account seeding after a held envelope retires', async () => {
  let deliver!: (value: {
    sessions: [];
    accountUsage: ReturnType<typeof createMockAccountUsage>[];
  }) => void;
  let current = true;
  const queryClient = new QueryClient();
  const transport = createMockTransport({
    listSessions: vi.fn(
      () =>
        new Promise<Parameters<typeof deliver>[0]>((resolve) => {
          deliver = resolve;
        })
    ),
  });
  const running = sessionListQueryOptions(
    {
      transport,
      queryClient,
      effectOwner: {
        beforeEffect: () => {
          if (!current) throw new Error('EXTENSION_RETIRED');
        },
      },
    },
    null
  ).queryFn();
  current = false;
  deliver({ sessions: [], accountUsage: [createMockAccountUsage()] });
  await expect(running).rejects.toThrow('EXTENSION_RETIRED');
  expect(queryClient.getQueryData(accountKeys.usage('claude-code'))).toBeUndefined();
});
