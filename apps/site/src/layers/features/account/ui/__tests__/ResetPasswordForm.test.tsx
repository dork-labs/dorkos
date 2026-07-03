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
  resetPassword: vi.fn(),
}));

import { resetPassword } from '@/lib/auth-client';

import { ResetPasswordForm } from '../ResetPasswordForm';

const NEW_PASSWORD = 'a-brand-new-password';
const TOKEN = 'reset-token-123';

describe('ResetPasswordForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an invalid-link state when the token is missing', () => {
    render(<ResetPasswordForm />);

    expect(screen.getByText('This reset link is invalid')).toBeTruthy();
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('submits the new password with the token and shows the success state', async () => {
    vi.mocked(resetPassword).mockResolvedValue({ data: {}, error: null } as never);
    render(<ResetPasswordForm token={TOKEN} />);

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: NEW_PASSWORD } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: NEW_PASSWORD },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() =>
      expect(resetPassword).toHaveBeenCalledWith({ newPassword: NEW_PASSWORD, token: TOKEN })
    );
    await waitFor(() => expect(screen.getByText('Password updated')).toBeTruthy());
  });

  it('rejects mismatched passwords without calling the client', () => {
    render(<ResetPasswordForm token={TOKEN} />);

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: NEW_PASSWORD } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'mismatch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    expect(resetPassword).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Passwords do not match');
  });

  it('surfaces an expired-token error from the server', async () => {
    vi.mocked(resetPassword).mockResolvedValue({
      data: null,
      error: { status: 400, message: 'Invalid or expired token' },
    } as never);
    render(<ResetPasswordForm token={TOKEN} />);

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: NEW_PASSWORD } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: NEW_PASSWORD },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Invalid or expired token')
    );
    expect(screen.queryByText('Password updated')).toBeNull();
  });
});
