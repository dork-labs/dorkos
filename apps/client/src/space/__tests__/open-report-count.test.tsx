// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManageButton } from '../moderation/ManageButton.js';
import { announceReportsChanged, openReportLabel } from '../moderation/OpenReportBadge.js';
import { mockFetch } from '../owner-replacement/__tests__/harness.js';

// DOR-3625: nothing told a moderator a message was flagged until they opened the queue.

const reports = (count: number) => Array.from({ length: count }, (_, id) => ({ id }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the Manage button', () => {
  it('shows a moderator how many messages are flagged, and says so aloud', async () => {
    mockFetch({
      'GET /api/v1/reports': () => ({ status: 200, body: { reports: reports(3) } }),
    });
    render(<ManageButton memberRole="admin" onOpen={() => undefined} />);
    expect(await screen.findByRole('button', { name: 'Manage, 3 flagged' })).toBeTruthy();
    expect(screen.getByText('3', { exact: true })).toBeTruthy();
  });

  it('shows nothing when no message is flagged', async () => {
    const calls = mockFetch({
      'GET /api/v1/reports': () => ({ status: 200, body: { reports: [] } }),
    });
    render(<ManageButton memberRole="owner" onOpen={() => undefined} />);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('never asks for the queue for a plain member', async () => {
    const calls = mockFetch({});
    render(<ManageButton memberRole="member" onOpen={() => undefined} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(calls).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
  });

  it('reads the count again when a report is resolved', async () => {
    let open = 2;
    mockFetch({
      'GET /api/v1/reports': () => ({ status: 200, body: { reports: reports(open) } }),
    });
    render(<ManageButton memberRole="admin" onOpen={() => undefined} />);
    await screen.findByRole('button', { name: 'Manage, 2 flagged' });
    open = 0;
    act(() => announceReportsChanged());
    expect(await screen.findByRole('button', { name: 'Manage' })).toBeTruthy();
  });

  it('keeps the last count when a read fails', async () => {
    let fail = false;
    mockFetch({
      'GET /api/v1/reports': () =>
        fail
          ? { status: 500, body: { code: 'INTERNAL', message: 'no' } }
          : { status: 200, body: { reports: reports(1) } },
    });
    render(<ManageButton memberRole="admin" onOpen={() => undefined} />);
    await screen.findByRole('button', { name: 'Manage, 1 flagged' });
    fail = true;
    await act(async () => {
      announceReportsChanged();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.getByRole('button', { name: 'Manage, 1 flagged' })).toBeTruthy();
  });
});

describe('the label', () => {
  it('caps at 99+, as the app’s counts do', () => {
    expect(openReportLabel(99)).toBe('99');
    expect(openReportLabel(100)).toBe('99+');
    expect(openReportLabel(200)).toBe('99+');
  });
});
