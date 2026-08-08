/**
 * @vitest-environment jsdom
 *
 * Whose profile the Settings tab edits, and what it says when there is nobody.
 *
 * The two no-form states are the point. A read that FAILED and a read that
 * SUCCEEDED with an empty roster look identical from `!self`, and they are not
 * the same thing: the first is worth retrying, the second is the Obsidian
 * embed, whose roster stub answers `{ members: [] }` by construction. Telling
 * that person to reopen the tab sends them round a loop that cannot terminate.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { ProfilePanelContainer } from '../ui/ProfilePanelContainer';

const SELF = MOCK_TEAM_ROSTER.find((member) => member.isSelf)!;

function renderContainer(getTeamRoster: Transport['getTeamRoster']) {
  const transport = createMockTransport({ getTeamRoster } as Partial<Transport>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ProfilePanelContainer />
      </TransportProvider>
    </QueryClientProvider>
  );
}

afterEach(cleanup);

describe('ProfilePanelContainer', () => {
  it('waits while the roster is still being read', () => {
    renderContainer(vi.fn().mockReturnValue(new Promise(() => {})));
    expect(screen.getByText('Loading your profile…')).toBeInTheDocument();
    // Not the form, and not either of the two "nobody" sentences.
    expect(screen.queryByLabelText('Handle')).not.toBeInTheDocument();
  });

  it('invites a retry when the read FAILED', async () => {
    renderContainer(vi.fn().mockRejectedValue(new Error('roster unreachable')));
    expect(await screen.findByText(/could not read your profile/i)).toBeInTheDocument();
  });

  it('names the missing server when the read SUCCEEDED with nobody on it', async () => {
    // The Obsidian embed's own answer — a 200 with an empty roster, not an error.
    renderContainer(
      vi.fn().mockResolvedValue({
        members: [],
        warnings: [{ source: 'team', message: 'No DorkOS server in embedded mode.' }],
      })
    );

    expect(await screen.findByText(/needs a DorkOS server/i)).toBeInTheDocument();
    // The retry sentence would be a loop that cannot terminate here.
    expect(screen.queryByText(/try reopening this tab/i)).not.toBeInTheDocument();
  });

  it('draws the form on your own row', async () => {
    renderContainer(vi.fn().mockResolvedValue({ members: MOCK_TEAM_ROSTER }));
    expect(await screen.findByLabelText('Display name')).toHaveValue(SELF.displayName);
  });
});
