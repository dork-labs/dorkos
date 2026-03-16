// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionBanner } from '../ui/PermissionBanner';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

afterEach(() => {
  cleanup();
});

function createWrapper(sessionData?: Record<string, unknown>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (sessionData) {
    queryClient.setQueryData(['session', sessionData.id], sessionData);
  }
  const transport = createMockTransport();
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('PermissionBanner', () => {
  it('returns null when sessionId is null', () => {
    const { container } = render(<PermissionBanner sessionId={null} />, {
      wrapper: createWrapper(),
    });
    expect(container.textContent).toBe('');
  });

  it('returns null when session has no data yet', () => {
    const { container } = render(<PermissionBanner sessionId="s-unknown" />, {
      wrapper: createWrapper(),
    });
    expect(container.textContent).toBe('');
  });

  it('returns null for default permission mode', () => {
    const session = {
      id: 's1',
      permissionMode: 'default',
      title: 'Test',
      createdAt: '',
      updatedAt: '',
    };
    const { container } = render(<PermissionBanner sessionId="s1" />, {
      wrapper: createWrapper(session),
    });
    expect(container.textContent).toBe('');
  });

  it('returns null even for bypassPermissions mode (banner hidden)', () => {
    const session = {
      id: 's2',
      permissionMode: 'bypassPermissions',
      title: 'Test',
      createdAt: '',
      updatedAt: '',
    };
    const { container } = render(<PermissionBanner sessionId="s2" />, {
      wrapper: createWrapper(session),
    });
    expect(container.textContent).toBe('');
  });
});
