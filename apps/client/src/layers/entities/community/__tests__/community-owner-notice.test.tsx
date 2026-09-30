/** @vitest-environment jsdom */
/**
 * The owner's notice about a request to replace them (DOR-2543): what it says, and that each
 * request is announced exactly once, however many polls and reloads later it is still showing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Transport } from '@dorkos/shared/transport';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import type {
  CommunityConnectionDescriptor,
  CommunityConnectionOwnerNotice,
} from '@dorkos/shared/community-connections';
import { createMockTransport } from '@dorkos/test-utils';
import { invalidateCommunityAuthority } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import {
  communityPageUrl,
  ownerNoticeAnnouncement,
  ownerNoticeBanner,
  type OpenOwnerNotice,
} from '../lib/owner-notice';
import {
  OWNER_NOTICE_ANNOUNCED_KEY,
  resetOwnerNoticeAnnouncementsForTests,
  useCommunityOwnerNoticeAnnouncer,
} from '../model/use-community-owner-notice-announcer';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
const openExternalLink = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  openExternalLink,
}));

const UTC = { locale: 'en-US', timeZone: 'UTC' };
const capabilities = { read: true, post: true, enrollAgent: true, stream: true };

const open: OpenOwnerNotice = {
  state: 'open',
  replacementId: 'replacement-1',
  requestState: 'waiting',
  requestedAt: '2026-09-20T10:00:00.000Z',
  claimableAfter: '2026-10-04T10:00:00.000Z',
  claimReissuedAt: null,
  options: { keep: true, transfer: true, delete: true, needsPassword: false },
};
const completed: CommunityConnectionOwnerNotice = {
  state: 'completed',
  replacementId: 'replacement-1',
  newOwnerDisplayName: 'Riley',
  completedAt: '2026-10-05T09:00:00.000Z',
};

function connection(
  ref: string,
  label: string,
  ownerNotice?: CommunityConnectionOwnerNotice
): CommunityConnectionDescriptor {
  return {
    ref: CommunityRefSchema.parse(ref),
    remoteCommunityId: `remote-${ref}`,
    label,
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
  };
}

function Announcer() {
  useCommunityOwnerNoticeAnnouncer();
  return null;
}

/** One page load: a fresh query cache and a fresh page memory, over the same browser storage. */
function load(transport: Transport) {
  resetOwnerNoticeAnnouncementsForTests();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <Announcer />
      </TransportProvider>
    </QueryClientProvider>
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  invalidateCommunityAuthority();
});

describe('announcing a request to replace the owner', () => {
  // Purpose: one notification per request id, however many polls and reloads later it is still
  // showing. Fails if the announcer keyed on the poll, the page, or anything but the request.
  it('announces an open request once across polls and reloads', async () => {
    const list = vi.fn().mockResolvedValue([connection('a', 'Alpha', open)]);
    const transport = createMockTransport({ listCommunityConnections: list });
    const client = load(transport);
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Someone asked to take over Alpha', {
        id: 'community-owner-notice:open:replacement-1',
        description: expect.stringContaining('Unless you keep ownership'),
        action: { label: 'Open community', onClick: expect.any(Function) },
      })
    );
    // Another poll answers the same request.
    await client.refetchQueries();
    expect(list).toHaveBeenCalledTimes(2);
    cleanup();
    // A reload: new page, same browser.
    load(transport);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(toast.warning).toHaveBeenCalledTimes(1);

    // The notification's button opens the community on its own host.
    const [, options] = vi.mocked(toast.warning).mock.calls[0]!;
    (options as { action: { onClick: () => void } }).action.onClick();
    expect(openExternalLink).toHaveBeenCalledWith('https://a.example/c/remote-a');
  });

  // Purpose: the completion is its own notification, once, and the open one is not repeated.
  it('announces the completion once, after the request', async () => {
    const list = vi.fn().mockResolvedValue([connection('a', 'Alpha', open)]);
    const transport = createMockTransport({ listCommunityConnections: list });
    load(transport);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    cleanup();
    list.mockResolvedValue([connection('a', 'Alpha', completed)]);
    load(transport);
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('Riley is now the owner of Alpha', {
        id: 'community-owner-notice:completed:replacement-1',
        description: 'You are still a member.',
      })
    );
    cleanup();
    load(transport);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  // Purpose: a new request is new news, even for a community that had one before.
  it('announces a second request on the same community', async () => {
    const list = vi.fn().mockResolvedValue([connection('a', 'Alpha', open)]);
    const transport = createMockTransport({ listCommunityConnections: list });
    load(transport);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    cleanup();
    list.mockResolvedValue([connection('a', 'Alpha', { ...open, replacementId: 'replacement-2' })]);
    load(transport);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(2));
  });

  // Purpose: a member's connection carries no notice, so a member is told nothing.
  it('says nothing for a connection without a notice', async () => {
    const list = vi.fn().mockResolvedValue([connection('b', 'Beta')]);
    load(createMockTransport({ listCommunityConnections: list }));
    await waitFor(() => expect(list).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(localStorage.getItem(OWNER_NOTICE_ANNOUNCED_KEY)).toBeNull();
  });

  // Purpose: without storage the page's own memory still stops a repeat within the page.
  it('announces once per page when the browser keeps nothing', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const list = vi.fn().mockResolvedValue([connection('a', 'Alpha', open)]);
      const transport = createMockTransport({ listCommunityConnections: list });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      resetOwnerNoticeAnnouncementsForTests();
      render(
        <QueryClientProvider client={client}>
          <TransportProvider transport={transport}>
            <Announcer />
          </TransportProvider>
        </QueryClientProvider>
      );
      await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
      await client.refetchQueries();
      expect(list).toHaveBeenCalledTimes(2);
      expect(toast.warning).toHaveBeenCalledTimes(1);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('what the owner reads', () => {
  it('names the date and offers every option this owner has', () => {
    expect(ownerNoticeBanner(open, 'active', UTC)).toEqual([
      'The host has been asked to make someone else the owner of this community. Unless you keep ownership, that can happen on or after Sunday, October 4, 2026.',
      'Open the community to keep ownership. You can also hand it to someone yourself, or delete it.',
    ]);
  });

  // Purpose: copy never offers what this owner cannot do. Fails if a held or archived community
  // offered a hand-over, or an owner without a password were told they could delete.
  it('offers only deleting when the community cannot be handed over', () => {
    const lines = ownerNoticeBanner(
      { ...open, options: { keep: true, transfer: false, delete: true, needsPassword: false } },
      'archived',
      UTC
    );
    expect(lines[1]).toBe('Open the community to keep ownership. You can also delete it.');
  });

  it('tells an owner without a password what adding one would allow', () => {
    const noPassword = {
      ...open,
      options: { keep: true as const, transfer: false, delete: false, needsPassword: true },
    };
    expect(ownerNoticeBanner(noPassword, 'active', UTC)[1]).toBe(
      'Open the community to keep ownership. To hand it to someone or delete it, add a password to your account first.'
    );
    expect(ownerNoticeBanner(noPassword, 'held', UTC)[1]).toBe(
      'Open the community to keep ownership. To delete it, add a password to your account first.'
    );
  });

  it('says when the date is not set yet, when it has passed, and when the link was resent', () => {
    expect(ownerNoticeBanner({ ...open, claimableAfter: null }, 'active', UTC)[0]).toMatch(
      /that can happen after a waiting period of at least 7 days\.$/
    );
    expect(ownerNoticeBanner({ ...open, requestState: 'claimable' }, 'active', UTC)[0]).toMatch(
      /that can happen at any time now\.$/
    );
    expect(
      ownerNoticeBanner({ ...open, claimReissuedAt: '2026-09-25T08:00:00.000Z' }, 'active', UTC)[2]
    ).toBe('The link for the new owner was sent again on Friday, September 25, 2026.');
  });

  it('writes the notifications and the community’s address', () => {
    expect(ownerNoticeAnnouncement(open, 'Alpha', UTC)).toEqual({
      title: 'Someone asked to take over Alpha',
      description:
        'Unless you keep ownership, the host can make someone else its owner on or after Sunday, October 4, 2026.',
    });
    expect(communityPageUrl({ pinnedOrigin: 'https://c.example', remoteCommunityId: 'a b' })).toBe(
      'https://c.example/c/a%20b'
    );
  });
});
