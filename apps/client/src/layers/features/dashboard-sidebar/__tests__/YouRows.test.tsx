// @vitest-environment jsdom
/**
 * The phone's You tab opens with the same two rows the header menu does
 * (DOR-2628): you, then your DorkOS account.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';

import {
  buildProfileDeepLinkHarness,
  type ProfileDeepLinkHarness,
} from '@/test-helpers/profile-deep-link';

let mockSelf: { id: string; displayName: string; isSelf: boolean } | null = null;

vi.mock('@/layers/entities/team', async (importOriginal) => ({
  teamMemberFace: (await importOriginal<typeof import('@/layers/entities/team')>()).teamMemberFace,
  useTeamRoster: () => ({ data: { members: mockSelf === null ? [] : [mockSelf] } }),
}));

import { TransportProvider } from '@/layers/shared/model';
import { YouRows } from '../ui/context/YouRows';

// The rows open through the REAL deep-link hooks inside a real router, so a
// click is checked by the URL it leaves behind (`?profile=me`,
// `?settings=account`) — the address a reload reopens. A mocked hook would
// accept any id from any id space.
async function renderRows(
  transport: Transport = createMockTransport()
): Promise<ProfileDeepLinkHarness> {
  const harness = buildProfileDeepLinkHarness();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <harness.Wrapper>
          <YouRows />
        </harness.Wrapper>
      </TransportProvider>
    </QueryClientProvider>
  );
  await harness.ready();
  return harness;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelf = { id: 'me', displayName: 'Dorian', isSelf: true };
});
afterEach(() => cleanup());

describe('YouRows', () => {
  it('shows you, then your DorkOS account, in that order', async () => {
    await renderRows();
    const rows = screen.getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Dorian\s*View profile$/),
      expect.stringMatching(/^DorkOS account/),
    ]);
    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
  });

  it('opens your own profile', async () => {
    const harness = await renderRows();
    fireEvent.click(screen.getByRole('button', { name: /Dorian/ }));
    await waitFor(() => expect(harness.openProfileId()).toBe('me'));
    expect(harness.openSettingsTab()).toBeNull();
  });

  it('opens Settings on the DorkOS account tab', async () => {
    const harness = await renderRows();
    fireEvent.click(screen.getByRole('button', { name: /DorkOS account/ }));
    await waitFor(() => expect(harness.openSettingsTab()).toBe('account'));
    expect(harness.openProfileId()).toBeNull();
  });

  it('says who the account is signed in as, in the service’s words', async () => {
    await renderRows(
      createMockTransport({
        getCloudStatus: vi.fn().mockResolvedValue({
          linked: true,
          accountLabel: 'kai@dork.dev',
          lastHeartbeatAt: null,
        }),
      })
    );
    expect(await screen.findByText('Signed in · kai@dork.dev')).toBeInTheDocument();
  });

  it('keeps the account row when the roster names nobody yet', async () => {
    mockSelf = null;
    await renderRows();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /DorkOS account/ })).toBeInTheDocument();
  });
});
