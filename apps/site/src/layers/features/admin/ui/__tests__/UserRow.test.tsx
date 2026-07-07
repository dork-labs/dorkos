/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

// UserRow composes AdminAction, which imports these mutation wrappers; stub the
// whole client module so nothing reaches Better Auth.
vi.mock('@/lib/auth-client', () => ({
  adminBanUser: vi.fn(),
  adminImpersonateUser: vi.fn(),
  adminRemoveUser: vi.fn(),
  adminRevokeUserSessions: vi.fn(),
  adminSetRole: vi.fn(),
  adminUnbanUser: vi.fn(),
}));

import type { AdminUserView } from '@/lib/admin-service';

import { UserRow } from '../UserRow';

const BASE: AdminUserView = {
  id: 'u1',
  email: 'kai@dork.test',
  name: 'Kai',
  role: 'user',
  banned: false,
  banReason: null,
  banExpires: null,
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('UserRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables all actions on the admin’s own row and explains why', () => {
    render(<UserRow user={BASE} isSelf={true} />);

    expect(screen.getByText('actions disabled on your account')).toBeTruthy();
    expect(screen.getByText('you')).toBeTruthy();
    // None of the mutating action triggers are rendered for the self row.
    for (const label of ['Make admin', 'Ban', 'Impersonate', 'Revoke sessions', 'Delete']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('renders the full action set for another user', () => {
    render(<UserRow user={BASE} isSelf={false} />);

    expect(screen.queryByText('actions disabled on your account')).toBeNull();
    for (const label of ['Make admin', 'Ban', 'Impersonate', 'Revoke sessions', 'Delete']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    // A plain, verified, non-admin user shows none of the status badges.
    expect(screen.queryByText('admin')).toBeNull();
    expect(screen.queryByText('banned')).toBeNull();
    expect(screen.queryByText('unverified')).toBeNull();
  });

  it('shows the admin badge and a demote action for an admin user', () => {
    render(<UserRow user={{ ...BASE, role: 'admin' }} isSelf={false} />);

    expect(screen.getByText('admin')).toBeTruthy();
    // Admins get "Make user" (demote), not "Make admin".
    expect(screen.getByRole('button', { name: 'Make user' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make admin' })).toBeNull();
  });

  it('shows the banned badge and an unban action for a banned user', () => {
    render(<UserRow user={{ ...BASE, banned: true, banReason: 'spam' }} isSelf={false} />);

    expect(screen.getByText('banned')).toBeTruthy();
    // Banned users get "Unban", replacing the "Ban" action.
    expect(screen.getByRole('button', { name: 'Unban' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ban' })).toBeNull();
  });

  it('shows the unverified badge when the email is not confirmed', () => {
    render(<UserRow user={{ ...BASE, emailVerified: false }} isSelf={false} />);
    expect(screen.getByText('unverified')).toBeTruthy();
  });
});
