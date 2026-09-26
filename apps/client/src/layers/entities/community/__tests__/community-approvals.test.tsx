/** @vitest-environment jsdom */
/**
 * The app-level approval watcher: it checks every pending connection, stops
 * checking one whose wait ended, reports each ending exactly once, and hands an
 * on-screen ending to its dialog instead of a toast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Transport } from '@dorkos/shared/transport';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { createMockTransport } from '@dorkos/test-utils';
import {
  getCommunityAuthority,
  invalidateCommunityAuthority,
  type ConfirmedCommunityAuthority,
} from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import {
  communityOwnerAddress,
  useCommunityApprovalStore,
  useCommunityApprovalWatcher,
} from '../model/community-approvals';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function waiting(ref: string, label: string): CommunityConnectionDescriptor {
  return {
    ref: CommunityRefSchema.parse(ref),
    remoteCommunityId: `remote-${ref}`,
    label,
    pinnedOrigin: `https://${ref}.example`,
    connectedHumanMemberId: null,
    status: 'pending',
    expiresAt: null,
    access: null,
    attention: null,
  };
}
const a = waiting('ref-a', 'Community A');
const b = waiting('ref-b', 'Community B');

beforeEach(() => {
  vi.clearAllMocks();
  useCommunityApprovalStore.setState({ onScreen: null, ending: null, links: null });
});
afterEach(() => {
  cleanup();
  invalidateCommunityAuthority();
});

function Watcher() {
  useCommunityApprovalWatcher();
  return null;
}

function mount(transport: Transport) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <Watcher />
      </TransportProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

describe('useCommunityApprovalWatcher', () => {
  it('toasts an approval that lands while no dialog shows it', async () => {
    const poll = vi.fn().mockResolvedValue({ status: 'connected', connection: null });
    mount(
      createMockTransport({
        listCommunityConnections: vi.fn().mockResolvedValue([a]),
        pollCommunityConnection: poll,
      })
    );
    await waitFor(() => expect(poll).toHaveBeenCalledWith(a.ref));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Community A is connected.', expect.anything())
    );
  });

  it('hands an ending to the dialog showing that wait, not to a toast', async () => {
    useCommunityApprovalStore.getState().show(a.ref);
    mount(
      createMockTransport({
        listCommunityConnections: vi.fn().mockResolvedValue([a]),
        pollCommunityConnection: vi.fn().mockResolvedValue({ status: 'expired', connection: null }),
      })
    );
    await waitFor(() =>
      expect(useCommunityApprovalStore.getState().ending).toMatchObject({
        ref: a.ref,
        label: 'Community A',
        outcome: 'expired',
      })
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('reports each ending once, even as later endings re-run it', async () => {
    // The list keeps showing both as pending (it has not been re-read yet), so
    // A's ending is still there when B's arrives.
    let bEnds = false;
    const poll = vi.fn((ref: string) =>
      Promise.resolve(
        ref === a.ref || bEnds
          ? { status: 'cancelled' as const, connection: null }
          : { status: 'pending' as const, connection: b }
      )
    );
    const view = mount(
      createMockTransport({
        listCommunityConnections: vi.fn().mockResolvedValue([a, b]),
        pollCommunityConnection: poll,
      })
    );
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Approval for Community A was cancelled.',
        expect.anything()
      )
    );
    bEnds = true;
    await waitFor(
      () =>
        expect(toast.warning).toHaveBeenCalledWith(
          'Approval for Community B was cancelled.',
          expect.anything()
        ),
      { timeout: 5_000 }
    );
    view.rerender();
    view.rerender();
    const aReports = vi
      .mocked(toast.warning)
      .mock.calls.filter(([message]) => message === 'Approval for Community A was cancelled.');
    expect(aReports).toHaveLength(1);
  });

  it('stops checking a wait once it has ended', async () => {
    const poll = vi.fn().mockResolvedValue({ status: 'expired', connection: null });
    mount(
      createMockTransport({
        // Still listed as pending, so only the ending itself can stop the checks.
        listCommunityConnections: vi.fn().mockResolvedValue([a]),
        pollCommunityConnection: poll,
      })
    );
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const calls = poll.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    expect(poll).toHaveBeenCalledTimes(calls);
  });

  it('drops the approval links it holds when the owner changes or signs out', async () => {
    mount(createMockTransport({ listCommunityConnections: vi.fn().mockResolvedValue([]) }));
    await waitFor(() => expect(getCommunityAuthority().ownerKey).not.toBeNull());
    const owner = communityOwnerAddress(getCommunityAuthority() as ConfirmedCommunityAuthority);
    act(() => {
      useCommunityApprovalStore.getState().rememberLink(owner, a.ref, 'https://a.example/pair');
    });
    expect(useCommunityApprovalStore.getState().links?.urls[a.ref]).toBe('https://a.example/pair');
    act(() => {
      invalidateCommunityAuthority();
    });
    await waitFor(() => expect(useCommunityApprovalStore.getState().links).toBeNull());
  });

  it('checks a wait again every two seconds while it is pending', async () => {
    const poll = vi.fn().mockResolvedValue({ status: 'pending', connection: a });
    mount(
      createMockTransport({
        listCommunityConnections: vi.fn().mockResolvedValue([a]),
        pollCommunityConnection: poll,
      })
    );
    await waitFor(() => expect(poll).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
