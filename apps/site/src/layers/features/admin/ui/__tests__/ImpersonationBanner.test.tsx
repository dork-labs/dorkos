/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

const { useSession, adminStopImpersonating } = vi.hoisted(() => ({
  useSession: vi.fn(),
  adminStopImpersonating: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({ useSession, adminStopImpersonating }));

import { ImpersonationBanner } from '../ImpersonationBanner';

describe('ImpersonationBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing for an ordinary (non-impersonation) session', () => {
    useSession.mockReturnValue({
      data: { user: { email: 'me@dork.test' }, session: { id: 's1' } },
    });

    const { container } = render(<ImpersonationBanner />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Stop impersonating')).toBeNull();
  });

  it('renders the banner and the impersonated email when session.impersonatedBy is set', () => {
    useSession.mockReturnValue({
      data: {
        user: { email: 'subject@dork.test' },
        session: { id: 's2', impersonatedBy: 'admin-1' },
      },
    });

    render(<ImpersonationBanner />);

    expect(screen.getByText('subject@dork.test')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop impersonating' })).toBeTruthy();
  });

  it('stops impersonating and returns to /admin on click', async () => {
    useSession.mockReturnValue({
      data: {
        user: { email: 'subject@dork.test' },
        session: { id: 's2', impersonatedBy: 'admin-1' },
      },
    });
    adminStopImpersonating.mockResolvedValue(undefined);

    render(<ImpersonationBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop impersonating' }));

    await waitFor(() => expect(adminStopImpersonating).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin'));
    expect(refresh).toHaveBeenCalled();
  });
});
