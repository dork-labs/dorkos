/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/auth-client', () => ({
  verifyEmail: vi.fn(),
}));

import { verifyEmail } from '@/lib/auth-client';

import { VerifyEmailCard } from '../VerifyEmailCard';

describe('VerifyEmailCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('confirms a valid token and shows the success state', async () => {
    vi.mocked(verifyEmail).mockResolvedValue({ data: { status: true }, error: null } as never);
    render(<VerifyEmailCard token="valid-token" />);

    await waitFor(() => expect(verifyEmail).toHaveBeenCalledWith('valid-token'));
    await waitFor(() => expect(screen.getByText('Email verified')).toBeTruthy());
    // Onward link to the account.
    const link = screen.getByRole('link', { name: /Go to your account/ });
    expect(link.getAttribute('href')).toBe('/account');
  });

  it('shows a failure state when the token is invalid', async () => {
    vi.mocked(verifyEmail).mockResolvedValue({
      data: null,
      error: { status: 400, message: 'invalid token' },
    } as never);
    render(<VerifyEmailCard token="bad-token" />);

    await waitFor(() => expect(screen.getByText("This link didn't work")).toBeTruthy());
    expect(screen.queryByText('Email verified')).toBeNull();
  });

  it('reports failure when the server redirected here with an error and no token', () => {
    render(<VerifyEmailCard errorParam="token_expired" />);

    expect(screen.getByText("This link didn't work")).toBeTruthy();
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it('shows success when it lands after a server-side verify (no token, no error)', () => {
    render(<VerifyEmailCard />);

    expect(screen.getByText('Email verified')).toBeTruthy();
    expect(verifyEmail).not.toHaveBeenCalled();
  });
});
