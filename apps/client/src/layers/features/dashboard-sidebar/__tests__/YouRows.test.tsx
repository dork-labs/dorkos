// @vitest-environment jsdom
/**
 * The phone's You tab opens with the same two rows the header menu does
 * (DOR-2628): you, then your DorkOS account.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';

const mockOpenSettings = vi.fn();
const mockOpenProfile = vi.fn();
let mockSelf: { id: string; displayName: string; isSelf: boolean } | null = null;

vi.mock('@/layers/entities/team', async (importOriginal) => ({
  teamMemberFace: (await importOriginal<typeof import('@/layers/entities/team')>()).teamMemberFace,
  useTeamRoster: () => ({ data: { members: mockSelf === null ? [] : [mockSelf] } }),
}));
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useSettingsDeepLink: () => ({ open: mockOpenSettings }),
    useProfileDeepLink: () => ({ open: mockOpenProfile }),
  };
});

import { TransportProvider } from '@/layers/shared/model';
import { YouRows } from '../ui/context/YouRows';

function renderRows(transport: Transport = createMockTransport()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <YouRows />
      </TransportProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelf = { id: 'me', displayName: 'Dorian', isSelf: true };
});
afterEach(() => cleanup());

describe('YouRows', () => {
  it('shows you, then your DorkOS account, in that order', async () => {
    renderRows();
    const rows = screen.getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Dorian\s*View profile$/),
      expect.stringMatching(/^DorkOS account/),
    ]);
    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
  });

  it('opens your profile, and the DorkOS account tab', () => {
    renderRows();
    fireEvent.click(screen.getByRole('button', { name: /Dorian/ }));
    expect(mockOpenProfile).toHaveBeenCalledWith('me');
    fireEvent.click(screen.getByRole('button', { name: /DorkOS account/ }));
    expect(mockOpenSettings).toHaveBeenCalledWith('account');
  });

  it('says who the account is signed in as, in the service’s words', async () => {
    renderRows(
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

  it('keeps the account row when the roster names nobody yet', () => {
    mockSelf = null;
    renderRows();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /DorkOS account/ })).toBeInTheDocument();
  });
});
