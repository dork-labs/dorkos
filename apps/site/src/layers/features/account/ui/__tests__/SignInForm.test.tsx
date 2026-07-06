/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/auth-client', () => ({
  signInEmail: vi.fn(),
  signInSocial: vi.fn(),
}));

import { signInEmail, signInSocial } from '@/lib/auth-client';

import { SignInForm } from '../SignInForm';

const EMAIL = 'kai' + '@' + 'dork.test';
const PASSWORD = 'correct-horse-battery-staple';

/** Fill and submit the email/password fields. */
function submitCredentials() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: EMAIL } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('SignInForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls the auth client with the entered credentials and redirects to returnTo', async () => {
    vi.mocked(signInEmail).mockResolvedValue({ data: {}, error: null } as never);
    render(<SignInForm returnTo="/account/instances" />);

    submitCredentials();

    await waitFor(() => {
      expect(signInEmail).toHaveBeenCalledWith({
        email: EMAIL,
        password: PASSWORD,
        callbackURL: '/account/instances',
      });
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/account/instances'));
  });

  it('falls back to /account for an unsafe returnTo', async () => {
    vi.mocked(signInEmail).mockResolvedValue({ data: {}, error: null } as never);
    render(<SignInForm returnTo="https://evil.example/steal" />);

    submitCredentials();

    await waitFor(() =>
      expect(signInEmail).toHaveBeenCalledWith(expect.objectContaining({ callbackURL: '/account' }))
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith('/account'));
  });

  it('validates that both fields are present before calling the client', () => {
    render(<SignInForm />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(signInEmail).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Enter your email and password');
  });

  it('shows clear retry-after copy when the sign-in is rate limited', async () => {
    vi.mocked(signInEmail).mockResolvedValue({ data: null, error: { status: 429 } } as never);
    render(<SignInForm />);

    submitCredentials();

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Too many attempts')
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('surfaces the server message on a failed sign-in', async () => {
    vi.mocked(signInEmail).mockResolvedValue({
      data: null,
      error: { status: 401, message: 'Invalid email or password' },
    } as never);
    render(<SignInForm />);

    submitCredentials();

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Invalid email or password')
    );
  });

  it('offers the GitHub and Google social flows', () => {
    // Never resolves: the real flow navigates away, so the button stays pending
    // and no post-resolve state update escapes act during the assertion.
    vi.mocked(signInSocial).mockReturnValue(new Promise(() => {}) as never);
    render(<SignInForm />);

    fireEvent.click(screen.getByRole('button', { name: /Continue with GitHub/ }));

    expect(signInSocial).toHaveBeenCalledWith({ provider: 'github', callbackURL: '/account' });
  });
});
