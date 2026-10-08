// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockSession, createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import {
  setSessionRouteContext,
  getSessionRouteContext,
} from '../../navigation/session-route-context';
import { sessionKeys } from '../../../api/query-keys';
import { useSessionStatus } from '../../settings/use-session-status';
import { useSessionDetail } from '../use-session-detail';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSafeNavigate: () => navigate,
}));
vi.mock('../../navigation/use-session-search', () => ({
  useSessionSearch: () => ({
    session: 'canonical-draft',
    draft: '1',
    launchRef: 'private-location',
  }),
}));

describe('persisted draft link cleanup', () => {
  it('keeps the launch location until native metadata is available, then removes draft fields', async () => {
    const sessionId = 'canonical-draft';
    const cwd = '/private/project';
    const transport = createMockTransport({
      getSession: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('Not persisted'), { status: 404 })),
    });
    vi.mocked(transport.updateSession).mockResolvedValue({
      ...createMockSession({ id: sessionId, cwd, permissionMode: 'plan', runtime: 'claude-code' }),
      runtimeUnbound: true,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setSessionRouteContext(sessionId, { cwd, runtime: 'codex', draft: true });
    navigate.mockClear();
    useAppStore.setState({ pendingAccount: { id: 'selected-account', sessionId } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        detail: useSessionDetail(sessionId),
        status: useSessionStatus(sessionId, null, false, 'codex'),
      }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.detail.isError).toBe(true));
    expect(navigate).not.toHaveBeenCalled();
    // The settings PATCH overlays a loose response even though the native read
    // was 404. This cache success is not evidence of a created conversation.
    await act(async () => {
      await result.current.status.updateSession({ permissionMode: 'plan' });
    });
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));
    expect(navigate).not.toHaveBeenCalled();
    expect(transport.updateSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        permissionMode: 'plan',
        runtime: 'codex',
        account: 'selected-account',
      }),
      cwd
    );
    expect(queryClient.getQueryData(sessionKeys.detail(sessionId, cwd))).toMatchObject({
      permissionMode: 'plan',
    });
    expect(getSessionRouteContext(sessionId)).toMatchObject({ draft: true, runtime: 'codex' });
    vi.mocked(transport.getSession).mockResolvedValue(
      createMockSession({ id: sessionId, cwd, runtime: 'codex' })
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: sessionKeys.bySession(sessionId) });
    });
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    useAppStore.setState({ pendingAccount: null });
    const target = navigate.mock.calls[0][0];
    expect(target.replace).toBe(true);
    expect(
      target.search({ session: sessionId, draft: '1', launchRef: 'private-location' })
    ).toMatchObject({
      session: sessionId,
      draft: undefined,
      launchRef: undefined,
      agentId: undefined,
    });
  });
});
