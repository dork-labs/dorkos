/**
 * @vitest-environment jsdom
 *
 * Which space pages open on the DorkOS account: exactly the servers the
 * account service names, and nothing while it has not answered or cannot.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { isAccountSignInLink, useCommunityAccountSignIn } from '../model/use-account-sign-in';

function wrapper(transport: Transport) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('isAccountSignInLink', () => {
  it('matches a link by its origin alone', () => {
    const origins = ['https://spaces.example.test'];
    expect(isAccountSignInLink(origins, 'https://spaces.example.test/c/x/join#invite=1')).toBe(
      true
    );
    expect(isAccountSignInLink(origins, ' https://spaces.example.test/claim ')).toBe(true);
    // A lookalike host, another port and another scheme are other servers.
    expect(isAccountSignInLink(origins, 'https://spaces.example.test.evil.test/claim')).toBe(false);
    expect(isAccountSignInLink(origins, 'https://spaces.example.test:8443/claim')).toBe(false);
    expect(isAccountSignInLink(origins, 'http://spaces.example.test/claim')).toBe(false);
    expect(isAccountSignInLink(origins, 'not a link')).toBe(false);
  });
});

describe('useCommunityAccountSignIn', () => {
  it('hints only the servers the account service names', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCommunityAccountSignIn).mockResolvedValue({
      available: true,
      origins: ['https://spaces.example.test'],
    });
    const { result } = renderHook(() => useCommunityAccountSignIn(), {
      wrapper: wrapper(transport),
    });
    await waitFor(() =>
      expect(result.current.signsInWithAccount('https://spaces.example.test/claim')).toBe(true)
    );
    expect(result.current.linkFor('https://spaces.example.test/claim#claim=t')).toBe(
      'https://spaces.example.test/claim?sign-in=single-sign-on#claim=t'
    );
    expect(result.current.linkFor('https://own.example.test/claim')).toBe(
      'https://own.example.test/claim'
    );
  });

  it('changes nothing while the service does not offer it, or cannot be read', async () => {
    for (const answer of [
      () => Promise.resolve({ available: false as const }),
      () => Promise.reject(new Error('offline')),
    ]) {
      const transport = createMockTransport();
      vi.mocked(transport.getCommunityAccountSignIn).mockImplementation(answer);
      const { result } = renderHook(() => useCommunityAccountSignIn(), {
        wrapper: wrapper(transport),
      });
      await waitFor(() => expect(transport.getCommunityAccountSignIn).toHaveBeenCalled());
      expect(result.current.signsInWithAccount('https://spaces.example.test/claim')).toBe(false);
      expect(result.current.linkFor('https://spaces.example.test/claim')).toBe(
        'https://spaces.example.test/claim'
      );
    }
  });

  it('asks nothing while no flow needs it', () => {
    const transport = createMockTransport();
    renderHook(() => useCommunityAccountSignIn(false), { wrapper: wrapper(transport) });
    expect(transport.getCommunityAccountSignIn).not.toHaveBeenCalled();
  });
});
