/** @vitest-environment jsdom */
import type { PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { AuthClientProvider } from '../model/auth-client-context';
import type { AuthClient } from '../model/auth-client';
import { authSessionKey, useSignOut } from '../model/use-auth-session';

describe('auth changes fence Community browser state', () => {
  it('removes protected Community queries before publishing the signed-out session', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(authSessionKey, { user: { id: 'owner-a' } });
    client.setQueryData(['communities', 'connections'], [{ ref: 'private-community' }]);
    client.setQueryData(['communities', 'private-community', 'room', 'same'], {
      title: 'Private room',
    });
    const auth = {
      signOut: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
    } as unknown as AuthClient;
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>
        <AuthClientProvider client={auth}>{children}</AuthClientProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useSignOut(), { wrapper });

    await act(async () => {
      await expect(result.current.run()).resolves.toEqual({ ok: true });
    });

    expect(client.getQueryData(['communities', 'connections'])).toBeUndefined();
    expect(
      client.getQueryData(['communities', 'private-community', 'room', 'same'])
    ).toBeUndefined();
    expect(client.getQueryData(authSessionKey)).toBeNull();
  });
});
