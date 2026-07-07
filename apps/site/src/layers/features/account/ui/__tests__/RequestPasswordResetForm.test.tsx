/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/auth-client', () => ({
  requestPasswordReset: vi.fn(),
}));

import { requestPasswordReset } from '@/lib/auth-client';

import { RequestPasswordResetForm } from '../RequestPasswordResetForm';

const EMAIL = 'kai' + '@' + 'dork.test';

describe('RequestPasswordResetForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requests a reset link and shows generic, enumeration-safe copy', async () => {
    vi.mocked(requestPasswordReset).mockResolvedValue({ data: {}, error: null } as never);
    render(<RequestPasswordResetForm />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: EMAIL } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() =>
      expect(requestPasswordReset).toHaveBeenCalledWith({
        email: EMAIL,
        redirectTo: '/reset-password/confirm',
      })
    );
    // Generic success copy — never confirms whether the email is registered.
    await waitFor(() =>
      expect(screen.getByText(/If an account exists for that email/)).toBeTruthy()
    );
  });

  it('shows the same generic copy even when the address has no account', async () => {
    // A "no such account" outcome is indistinguishable from success at the client.
    vi.mocked(requestPasswordReset).mockResolvedValue({ data: {}, error: null } as never);
    render(<RequestPasswordResetForm />);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'ghost' + '@' + 'dork.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() =>
      expect(screen.getByText(/If an account exists for that email/)).toBeTruthy()
    );
  });

  it('validates the email before calling the client', () => {
    render(<RequestPasswordResetForm />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(requestPasswordReset).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('valid email');
  });
});
