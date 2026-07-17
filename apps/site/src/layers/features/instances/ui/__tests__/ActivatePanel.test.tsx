/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-client', () => ({
  fetchPendingInstance: vi.fn(),
  approveDevice: vi.fn(),
  denyDevice: vi.fn(),
}));

import { approveDevice, denyDevice, fetchPendingInstance } from '@/lib/auth-client';

import { ActivatePanel } from '../ActivatePanel';

const PENDING = { status: 'pending', name: "Kai's MacBook", platform: 'darwin' } as const;

describe('ActivatePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-looks up a pre-filled code and shows the requesting instance', async () => {
    vi.mocked(fetchPendingInstance).mockResolvedValue(PENDING);
    render(<ActivatePanel initialCode="ABCD1234" />);

    await waitFor(() => expect(fetchPendingInstance).toHaveBeenCalledWith('ABCD1234'));
    expect(await screen.findByText("Kai's MacBook")).toBeTruthy();
    expect(screen.getByText(/darwin/)).toBeTruthy();
    // The pre-filled code still renders on the confirm screen, so the visitor
    // can check it against what their instance is showing (RFC 8628 anti-phishing).
    expect(screen.getByText('ABCD1234')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  });

  it('looks up a manually entered code', async () => {
    vi.mocked(fetchPendingInstance).mockResolvedValue(PENDING);
    render(<ActivatePanel />);

    fireEvent.change(screen.getByLabelText('Device code'), { target: { value: 'wxyz5678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Codes are normalized to uppercase before the lookup.
    await waitFor(() => expect(fetchPendingInstance).toHaveBeenCalledWith('WXYZ5678'));
    // The manually typed code also renders on the confirm screen, uppercased.
    expect(await screen.findByText('WXYZ5678')).toBeTruthy();
  });

  it('shows the code without stray dashes if the visitor typed one', async () => {
    vi.mocked(fetchPendingInstance).mockResolvedValue(PENDING);
    render(<ActivatePanel />);

    fireEvent.change(screen.getByLabelText('Device code'), { target: { value: 'wxyz-5678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(fetchPendingInstance).toHaveBeenCalledWith('WXYZ-5678'));
    expect(await screen.findByText('WXYZ5678')).toBeTruthy();
  });

  it('approves the request through the auth client', async () => {
    vi.mocked(fetchPendingInstance).mockResolvedValue(PENDING);
    vi.mocked(approveDevice).mockResolvedValue({ data: {}, error: null } as never);
    render(<ActivatePanel initialCode="ABCD1234" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(approveDevice).toHaveBeenCalledWith('ABCD1234'));
    expect(await screen.findByText(/is now linked/)).toBeTruthy();
  });

  it('denies the request through the auth client', async () => {
    vi.mocked(fetchPendingInstance).mockResolvedValue(PENDING);
    vi.mocked(denyDevice).mockResolvedValue({ data: {}, error: null } as never);
    render(<ActivatePanel initialCode="ABCD1234" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(denyDevice).toHaveBeenCalledWith('ABCD1234'));
    expect(await screen.findByText(/Request denied/)).toBeTruthy();
  });

  it('shows a regenerate hint when the code has expired', async () => {
    vi.mocked(fetchPendingInstance).mockResolvedValue({ status: 'expired' });
    render(<ActivatePanel initialCode="ABCD1234" />);

    expect(await screen.findByText(/generate a new code/)).toBeTruthy();
    expect(approveDevice).not.toHaveBeenCalled();
  });

  it('surfaces a lookup failure', async () => {
    vi.mocked(fetchPendingInstance).mockRejectedValue(new Error('network'));
    render(<ActivatePanel initialCode="ABCD1234" />);

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not look up/i);
  });
});
