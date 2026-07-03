/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock('@/lib/auth-client', () => ({
  signOut: vi.fn(),
}));

import { signOut } from '@/lib/auth-client';

import { AccountProfile } from '../AccountProfile';

const USER = {
  name: 'Kai Nakamura',
  email: 'kai' + '@' + 'dork.test',
  emailVerified: true,
};

describe('AccountProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the account name, email, and verification status', () => {
    render(<AccountProfile user={USER} />);

    expect(screen.getByText('Kai Nakamura')).toBeTruthy();
    expect(screen.getByText(USER.email)).toBeTruthy();
    expect(screen.getByText('Verified')).toBeTruthy();
  });

  it('shows an unverified status when the email is not confirmed', () => {
    render(<AccountProfile user={{ ...USER, emailVerified: false }} />);

    expect(screen.getByText('Unverified')).toBeTruthy();
    expect(screen.queryByText('Verified')).toBeNull();
  });

  it('signs out and returns to /signin', async () => {
    vi.mocked(signOut).mockResolvedValue(undefined as never);
    render(<AccountProfile user={USER} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/signin'));
  });
});
