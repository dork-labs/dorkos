// @vitest-environment jsdom
/**
 * The owner's banner at the top of a community's page (DOR-2543), read through the real
 * connection list over a mock Transport. It fails if a member's page showed a banner, if the
 * owner's page lost it, or if its button opened anything but the community on its own host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import type {
  CommunityConnectionDescriptor,
  CommunityConnectionOwnerNotice,
} from '@dorkos/shared/community-connections';
import { createMockTransport } from '@dorkos/test-utils';
import { invalidateCommunityAuthority } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { ChannelsPage } from '../ui/ChannelsPage';

const address = vi.hoisted(() => ({ community: 'owner-ref' as string, id: undefined }));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => address,
  useNavigate: () => vi.fn(),
}));
vi.mock('../ui/CommunityPageHeading', () => ({ CommunityPageHeading: () => null }));
vi.mock('../model/use-team-room-redirect', () => ({ useTeamRoomRedirect: () => 'show' }));
const openExternalLink = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  openExternalLink,
}));

const capabilities = { read: true, post: true, enrollAgent: true, stream: true };

function connection(ref: string, ownerNotice?: CommunityConnectionOwnerNotice) {
  return {
    ref: CommunityRefSchema.parse(ref),
    remoteCommunityId: `remote-${ref}`,
    label: `Community ${ref}`,
    pinnedOrigin: `https://${ref}.example`,
    connectedHumanMemberId: `member-${ref}`,
    status: 'connected',
    expiresAt: null,
    access: {
      state: 'verified',
      effective: capabilities,
      lastKnown: { lifecycle: 'active', capabilities, verifiedAt: '2026-09-30T00:00:00.000Z' },
    },
    attention: { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
    ...(ownerNotice ? { ownerNotice } : {}),
  } satisfies CommunityConnectionDescriptor;
}

const connections = [
  connection('owner-ref', {
    state: 'open',
    replacementId: 'replacement-1',
    requestState: 'waiting',
    requestedAt: '2026-09-20T10:00:00.000Z',
    claimableAfter: null,
    claimReissuedAt: null,
    options: { keep: true, transfer: true, delete: true, needsPassword: false },
  }),
  connection('member-ref'),
  // The prior owner after the request went through: news for the Inbox, not a warning here.
  connection('completed-ref', {
    state: 'completed',
    replacementId: 'replacement-1',
    newOwnerDisplayName: 'Riley',
    completedAt: '2026-10-05T09:00:00.000Z',
  }),
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const list = vi.fn().mockResolvedValue(connections);
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={createMockTransport({ listCommunityConnections: list })}>
        <ChannelsPage />
      </TransportProvider>
    </QueryClientProvider>
  );
  return list;
}

afterEach(() => {
  cleanup();
  invalidateCommunityAuthority();
  vi.clearAllMocks();
  address.community = 'owner-ref';
});

describe('the owner banner on a community’s page', () => {
  it('tells the owner, above the page, and opens the community on its own host', async () => {
    renderPage();
    const banner = await screen.findByRole('region', {
      name: 'Request to take over this space',
    });
    expect(banner).toHaveTextContent(
      'The host has been asked to make someone else the owner of this space. Unless you keep ownership, that can happen after a waiting period of at least 7 days.'
    );
    expect(banner).toHaveTextContent(
      'Open the space to keep ownership. You can also hand it to someone yourself, or delete it.'
    );
    // The page body is still there beneath it.
    expect(screen.getByText('No channel selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open space' }));
    expect(openExternalLink).toHaveBeenCalledWith('https://owner-ref.example/c/remote-owner-ref');
  });

  it.each(['member-ref', 'completed-ref'])('shows nothing on %s', async (ref) => {
    address.community = ref;
    const list = renderPage();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(await screen.findByText('No channel selected')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Request to take over this space' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open space' })).not.toBeInTheDocument();
  });
});
