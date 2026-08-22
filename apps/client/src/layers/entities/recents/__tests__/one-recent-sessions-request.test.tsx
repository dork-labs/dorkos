/**
 * "Jump back in" and the sidebar ask for recent sessions ONCE (spec
 * `sidebar-simplification` D6).
 *
 * Both are mounted on boot. They used to ask at two widths — 10 for the panel,
 * 24 for the list — which is two cache entries and two round trips, and the
 * visible cost was a second beat on load: Today's rows grew their second line
 * after the panel had already drawn them.
 *
 * Red when: either caller picks its own limit again.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RecentSessionsResponse } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { RECENT_SESSIONS_WINDOW, useRecentSessions } from '@/layers/entities/session';
import { useJumpBackIn } from '../model/use-jump-back-in';

const envelope: RecentSessionsResponse = { sessions: [], agentActivity: {}, warnings: [] };

describe('one recent-sessions request on boot', () => {
  it('serves both callers from a single fetch', async () => {
    const transport = createMockTransport({
      listRecentSessions: vi.fn().mockResolvedValue(envelope),
      listRooms: vi.fn().mockResolvedValue([]),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    // The two boot readers, mounted together exactly as the cockpit mounts
    // them: the panel's own read and the popover's.
    const { result } = renderHook(
      () => ({
        panel: useRecentSessions(RECENT_SESSIONS_WINDOW),
        jumpBackIn: useJumpBackIn(),
      }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.panel.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.jumpBackIn.isLoading).toBe(false));

    expect(transport.listRecentSessions).toHaveBeenCalledTimes(1);
    expect(transport.listRecentSessions).toHaveBeenCalledWith(RECENT_SESSIONS_WINDOW);
  });
});
