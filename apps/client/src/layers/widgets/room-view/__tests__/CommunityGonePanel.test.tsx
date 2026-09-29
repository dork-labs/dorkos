// @vitest-environment jsdom
/**
 * What stands in for a Community that is gone (DOR-2334): the wording for each case, and that
 * removing the local copy happens only on the person's confirmation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { confirmCommunityAuthority, invalidateCommunityAuthority } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { CommunityGonePanel, communityGoneState } from '../ui/CommunityGonePanel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));

afterEach(() => {
  cleanup();
  invalidateCommunityAuthority();
});

const base: CommunityConnectionDescriptor = {
  ref: 'alpha' as CommunityConnectionDescriptor['ref'],
  remoteCommunityId: 'community-id',
  label: 'Alpha',
  pinnedOrigin: 'https://alpha.example.com',
  connectedHumanMemberId: 'member',
  status: 'connected',
  expiresAt: null,
  access: {
    state: 'unverified',
    effective: { read: false, post: false, enrollAgent: false, stream: false },
    lastKnown: null,
  },
  attention: null,
};

function mount(connection: CommunityConnectionDescriptor) {
  const transport = createMockTransport();
  const authority = invalidateCommunityAuthority();
  confirmCommunityAuthority(authority.epoch, 'owner-a');
  const onRemoved = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TransportProvider transport={transport}>
        <CommunityGonePanel connection={connection} onRemoved={onRemoved} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, onRemoved };
}

describe('CommunityGonePanel', () => {
  it('knows which case a connection is in', () => {
    expect(communityGoneState(base)).toBeNull();
    expect(communityGoneState({ ...base, seemsGoneSince: '2026-09-01T00:00:00.000Z' })).toBe(
      'seems-gone'
    );
    expect(
      communityGoneState({
        ...base,
        access: {
          state: 'verified',
          effective: base.access!.effective,
          lastKnown: {
            lifecycle: 'deleted',
            capabilities: base.access!.effective,
            verifiedAt: '2026-09-29T00:00:00.000Z',
          },
        },
      })
    ).toBe('deleted');
  });

  // Purpose: "seems to be gone" says what is known and removes nothing until the person
  // confirms; confirming runs the disconnect, which purges on the server. It fails if the
  // removal runs without confirmation, or not at all.
  it('removes the local copy only after the person confirms', async () => {
    const user = userEvent.setup();
    const { transport, onRemoved } = mount({
      ...base,
      seemsGoneSince: '2026-09-01T12:00:00.000Z',
    });
    expect(screen.getByText('This community seems to be gone')).toBeInTheDocument();
    // It did answer, with "not found": say that, with the year, since two weeks can cross one.
    const expected = new Date('2026-09-01T12:00:00.000Z').toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    expect(
      screen.getByText(`Since ${expected}, Alpha has said this community doesn’t exist.`, {
        exact: false,
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove local copy' }));
    expect(transport.disconnectCommunity).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Remove your copy of Alpha?');

    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(transport.disconnectCommunity).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove local copy' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(
      Array.from(dialog.querySelectorAll('button')).find(
        (button) => button.textContent === 'Remove local copy'
      )!
    );
    await waitFor(() => expect(transport.disconnectCommunity).toHaveBeenCalledWith('alpha'));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledOnce());
  });

  it('says plainly when the community was deleted', () => {
    mount({
      ...base,
      access: {
        state: 'verified',
        effective: base.access!.effective,
        lastKnown: {
          lifecycle: 'deleted',
          capabilities: base.access!.effective,
          verifiedAt: '2026-09-29T00:00:00.000Z',
        },
      },
    });
    expect(screen.getByText('This community was deleted')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Alpha no longer exists, so DorkOS removed the copy it kept on this computer.'
      )
    ).toBeInTheDocument();
  });
});
