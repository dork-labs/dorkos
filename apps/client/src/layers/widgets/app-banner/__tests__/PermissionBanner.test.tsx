/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionBanner } from '../ui/PermissionBanner';

afterEach(() => {
  cleanup();
});

/** Wrapper seeding the session query cache the banner reads its permission mode from. */
function createWrapper(sessionData?: Record<string, unknown>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (sessionData) {
    queryClient.setQueryData(['session', sessionData.id], sessionData);
  }
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('PermissionBanner', () => {
  it('returns null when sessionId is null', () => {
    const { container } = render(<PermissionBanner sessionId={null} />, {
      wrapper: createWrapper(),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('returns null when the session has no data yet', () => {
    const { container } = render(<PermissionBanner sessionId="s-unknown" />, {
      wrapper: createWrapper(),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('returns null for the default permission mode', () => {
    const session = { id: 's1', permissionMode: 'default' };
    const { container } = render(<PermissionBanner sessionId="s1" />, {
      wrapper: createWrapper(session),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a warning (polite) banner in bypassPermissions mode', () => {
    const session = { id: 's2', permissionMode: 'bypassPermissions' };
    render(<PermissionBanner sessionId="s2" />, { wrapper: createWrapper(session) });

    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('data-variant', 'warning');
    expect(banner).toHaveTextContent('All permissions bypassed');
  });

  it('returns null for acceptEdits mode', () => {
    const session = { id: 's3', permissionMode: 'acceptEdits' };
    const { container } = render(<PermissionBanner sessionId="s3" />, {
      wrapper: createWrapper(session),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('returns null for plan mode', () => {
    const session = { id: 's4', permissionMode: 'plan' };
    const { container } = render(<PermissionBanner sessionId="s4" />, {
      wrapper: createWrapper(session),
    });
    expect(container).toBeEmptyDOMElement();
  });
});
