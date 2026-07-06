/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock('@/lib/auth-client', () => ({
  revokeInstanceLink: vi.fn(),
}));

import { revokeInstanceLink } from '@/lib/auth-client';
import type { InstanceView } from '@/lib/instance-types';

import { InstanceRegistry } from '../InstanceRegistry';

const NOW = new Date().toISOString();

const LIVE: InstanceView = {
  id: 'inst-1',
  name: "Kai's MacBook",
  platform: 'darwin',
  dorkosVersion: '0.4.2',
  createdAt: NOW,
  lastSeenAt: NOW,
  revokedAt: null,
};

describe('InstanceRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the empty state when there are no instances', () => {
    render(<InstanceRegistry instances={[]} />);
    expect(screen.getByText(/No instances are linked yet/)).toBeTruthy();
    expect(screen.getByText(/dorkos cloud login/)).toBeTruthy();
  });

  it('renders instance details from props', () => {
    render(<InstanceRegistry instances={[LIVE]} />);
    expect(screen.getByText("Kai's MacBook")).toBeTruthy();
    expect(screen.getByText(/darwin · v0\.4\.2/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy();
  });

  it('marks a revoked instance and hides its revoke button', () => {
    render(<InstanceRegistry instances={[{ ...LIVE, revokedAt: NOW }]} />);
    expect(screen.getByText('Revoked')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('revokes behind a confirmation dialog and refreshes', async () => {
    vi.mocked(revokeInstanceLink).mockResolvedValue(undefined);
    render(<InstanceRegistry instances={[LIVE]} />);

    // Opening the dialog does not call the endpoint.
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(revokeInstanceLink).not.toHaveBeenCalled();

    // Confirm inside the dialog (the AlertDialogAction) fires the revoke.
    const confirm = await screen.findByRole('button', { name: /^Revoke/ });
    fireEvent.click(confirm);

    await waitFor(() => expect(revokeInstanceLink).toHaveBeenCalledWith('inst-1'));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
