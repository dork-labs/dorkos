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
  signUpEmail: vi.fn(),
  signInSocial: vi.fn(),
}));

import { signInSocial, signUpEmail } from '@/lib/auth-client';

import { SignUpForm } from '../SignUpForm';

const NAME = 'Kai';
const EMAIL = 'kai' + '@' + 'dork.test';
const PASSWORD = 'correct-horse-battery-staple';

/** Fill every field; overrides let a test intentionally break one. */
function fillForm(
  overrides: Partial<Record<'name' | 'email' | 'password' | 'confirm', string>> = {}
) {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: overrides.name ?? NAME } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: overrides.email ?? EMAIL } });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: overrides.password ?? PASSWORD },
  });
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: overrides.confirm ?? PASSWORD },
  });
}

describe('SignUpForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(signInSocial).mockReturnValue(new Promise(() => {}) as never);
  });

  it('creates the account and shows the verify-email state', async () => {
    vi.mocked(signUpEmail).mockResolvedValue({ data: {}, error: null } as never);
    render(<SignUpForm />);

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(signUpEmail).toHaveBeenCalledWith({
        name: NAME,
        email: EMAIL,
        password: PASSWORD,
        callbackURL: '/verify-email',
      })
    );
    await waitFor(() => expect(screen.getByText('Verify your email')).toBeTruthy());
    // Confirmation names the address the link was sent to.
    expect(screen.getByText(EMAIL)).toBeTruthy();
  });

  it('rejects mismatched passwords without calling the client', () => {
    render(<SignUpForm />);

    fillForm({ confirm: 'different-password' });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(signUpEmail).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Passwords do not match');
  });

  it('rejects a too-short password', () => {
    render(<SignUpForm />);

    fillForm({ password: 'short', confirm: 'short' });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(signUpEmail).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('at least 8 characters');
  });

  it('surfaces a server error and stays on the form', async () => {
    vi.mocked(signUpEmail).mockResolvedValue({
      data: null,
      error: { status: 422, message: 'User already exists' },
    } as never);
    render(<SignUpForm />);

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('User already exists')
    );
    expect(screen.queryByText('Verify your email')).toBeNull();
  });
});
