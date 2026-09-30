// @vitest-environment jsdom
/**
 * What stands in for a Community that is gone (DOR-2334): the wording for each case, and that
 * removing the local copy happens only on the person's confirmation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  confirmCommunityAuthority,
  getCommunityAuthority,
  getCommunityConnectionGeneration,
  invalidateCommunityAuthority,
} from '@/layers/shared/lib';
import { useCommunityDraftStore } from '@/layers/entities/community';
import { TransportProvider } from '@/layers/shared/model';
import { CommunityGonePanel, communityGoneState, unsentSummary } from '../ui/CommunityGonePanel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));

afterEach(() => {
  cleanup();
  useCommunityDraftStore.getState().discardAll();
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
  // DOR-2334 review: a community recorded as taken down that later answers with a rejected
  // grant (the host reversed the takedown and lifted it) is not gone: reconnecting is the way on,
  // so the panel steps aside. It fails if the page keeps saying "taken down" with no way back.
  it('steps aside for a connection that needs reconnecting', () => {
    const takenDown: CommunityConnectionDescriptor = {
      ...base,
      status: 'reconnect-required',
      access: {
        state: 'reconnect-required',
        effective: base.access!.effective,
        lastKnown: {
          lifecycle: 'taken_down',
          capabilities: base.access!.effective,
          verifiedAt: '2026-09-29T00:00:00.000Z',
        },
      },
    };
    expect(communityGoneState(takenDown)).toBeNull();
    expect(
      communityGoneState({ ...takenDown, seemsGoneSince: '2026-09-01T00:00:00.000Z' })
    ).toBeNull();
  });

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

  // DOR-2334: a community its host took down says so, not "deleted".
  it('says plainly when the host took the community down', () => {
    mount({
      ...base,
      access: {
        state: 'verified',
        effective: base.access!.effective,
        lastKnown: {
          lifecycle: 'taken_down',
          capabilities: base.access!.effective,
          verifiedAt: '2026-09-29T00:00:00.000Z',
        },
      },
    });
    expect(screen.getByText('The host took this community down')).toBeInTheDocument();
    expect(screen.getByText(/The host of Alpha took it down/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove from DorkOS' })).toBeInTheDocument();
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

  // DOR-2575: what never reached a gone community, from both places it can be.
  describe('what didn’t send', () => {
    const deleted: CommunityConnectionDescriptor = {
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
    };
    /** Hold a draft as the composer would, under the owner the panel is mounted for. */
    function typeDraft(
      text: string,
      over: { ref?: string; ownerKey?: string; roomId?: string } = {}
    ) {
      const ref = over.ref ?? 'alpha';
      useCommunityDraftStore.getState().write(
        {
          ownerKey: over.ownerKey ?? 'owner-a',
          epoch: getCommunityAuthority().epoch,
          ref,
          generation: getCommunityConnectionGeneration(ref),
          roomId: over.roomId ?? 'general',
        },
        { text, files: [] }
      );
    }

    // Purpose: the sentence names each source with its own count and agrees in number. It fails
    // if a source is dropped, miscounted, or "wasn't"/"weren't" is wrong.
    it.each([
      [0, 0, null],
      [3, 1, '3 messages from your agents and 1 draft of yours weren’t sent.'],
      [1, 0, '1 message from your agents wasn’t sent.'],
      [0, 2, '2 drafts of yours weren’t sent.'],
      [1, 1, '1 message from your agents and 1 draft of yours weren’t sent.'],
    ] as Array<[number, number, string | null]>)(
      'says %i agent messages and %i drafts plainly',
      (agents, drafts, expected) => {
        expect(unsentSummary(agents, drafts)).toBe(expected);
      }
    );

    // Purpose: the panel counts the agents' posts the server kept a count of and the person's
    // drafts for THIS community only, offers to copy the drafts' text, and warns that removing
    // clears them. It fails if the server count or the drafts are not shown, if another
    // community's or owner's draft is counted or copied, or if the copy is not the drafts' text.
    it('tells the person what didn’t send and lets them copy their drafts', async () => {
      const user = userEvent.setup();
      mount({ ...deleted, undeliveredAgentMessages: 3 });
      act(() => {
        typeDraft('First thought');
        typeDraft('Second thought', { roomId: 'random' });
        typeDraft('Someone else’s community', { ref: 'beta' });
        typeDraft('Another owner', { ownerKey: 'owner-b' });
      });

      expect(screen.getByRole('status')).toHaveTextContent(
        '3 messages from your agents and 2 drafts of yours weren’t sent.'
      );
      await user.click(screen.getByRole('button', { name: 'Copy your drafts' }));
      expect(await navigator.clipboard.readText()).toBe('First thought\n\nSecond thought');
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      expect(screen.getByTestId('community-gone-copy-status')).toHaveTextContent('Copied.');
      expect(screen.getByTestId('community-gone-copy-status')).toHaveAttribute(
        'aria-live',
        'polite'
      );

      await user.click(screen.getByRole('button', { name: 'Remove from DorkOS' }));
      expect(screen.getByRole('alertdialog')).toHaveTextContent(
        'Your 2 unsent drafts are cleared too.'
      );
    });

    // Purpose: with nothing unsent, the panel adds nothing. It fails if an empty line or a copy
    // button with nothing to copy appears.
    it('adds nothing when everything was sent', () => {
      mount(deleted);
      expect(screen.queryByTestId('community-gone-unsent')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Copy your/ })).not.toBeInTheDocument();
    });

    // Purpose: a community that only seems gone still has its copy and its agents' posts, so only
    // the person's drafts are named. It fails if an agent count shows before anything was removed.
    it('names only the person’s drafts while a community only seems gone', () => {
      mount({ ...base, seemsGoneSince: '2026-09-01T12:00:00.000Z', undeliveredAgentMessages: 4 });
      act(() => typeDraft('Half a message'));
      expect(screen.getByTestId('community-gone-unsent')).toHaveTextContent(
        '1 draft of yours wasn’t sent.'
      );
      expect(screen.getByRole('button', { name: 'Copy your draft' })).toBeInTheDocument();
    });
  });
});
