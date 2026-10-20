// @vitest-environment jsdom
/**
 * A space's Settings tab (DOR-3005), as an owner, an admin, a member, a member of a space that
 * shows its directory to owners and admins only, and while the space cannot be reached; and the
 * private space's own short version.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, withSpacesExperiment } from '@dorkos/test-utils';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import type { CommunitySpaceRead } from '@dorkos/shared/community-space-settings';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { SpaceSettingsPanel } from '../ui/SpaceSettingsPanel';
import { PrivateSpaceSettings } from '../ui/PrivateSpaceSettings';

afterEach(cleanup);

const connection = {
  ref: 'northwind' as never,
  remoteCommunityId: '11111111-2222-4333-8444-555555555555',
  label: 'Northwind Studio',
  pinnedOrigin: 'https://spaces.example',
  connectedHumanMemberId: 'm-alex',
  status: 'connected',
  expiresAt: null,
} as unknown as CommunityConnectionDescriptor;

const FETCHED = '2026-10-20T08:00:00.000Z';

function person(id: string, name: string, role: 'owner' | 'admin' | 'member') {
  return {
    memberId: id,
    kind: 'human' as const,
    displayName: name,
    handle: name.split(' ')[0]!.toLowerCase(),
    role,
    ownerMemberId: null,
  };
}

const VALUES = {
  settings: {
    communityId: connection.remoteCommunityId,
    name: 'Northwind Studio',
    description: 'Where the team plans launches.',
    admissionPolicy: 'invite_only',
    hasIcon: false,
    settingsVersion: 3,
    lifecycle: 'active',
    lifecycleVersion: 1,
  },
  members: {
    members: [person('m-alex', 'Alex Kim', 'owner'), person('m-maya', 'Maya Chen', 'admin')],
    agents: [
      {
        memberId: 'a-scout',
        kind: 'agent' as const,
        displayName: 'Scout',
        handle: 'scout',
        role: null,
        ownerMemberId: 'm-alex',
        runsOn: 'computer' as const,
        lastSeenAt: FETCHED,
        availability: 'available' as const,
      },
    ],
    nextCursor: null,
  },
  rules: { text: 'Be kind, be direct.', version: 3, acceptedVersion: 3 },
};

function me(role: 'owner' | 'admin' | 'member') {
  return {
    member: { ...person('m-alex', 'Alex Kim', role), joinedAt: '2026-10-01T00:00:00.000Z' },
  };
}

function mount(
  role: 'owner' | 'admin' | 'member',
  options: { offline?: boolean; refuse?: Partial<Record<CommunitySpaceRead, string>> } = {}
) {
  const transport = withSpacesExperiment(createMockTransport());
  vi.mocked(transport.readCommunitySpace).mockImplementation(async (_ref, read) => {
    const refusal = options.refuse?.[read];
    if (refusal) throw Object.assign(new Error(refusal), { status: 403 });
    const value = read === 'me' ? me(role) : VALUES[read];
    return { value, fetchedAt: FETCHED, offline: options.offline ?? false } as never;
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <SpaceSettingsPanel connection={connection} />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('an owner', () => {
  it('reads every section as plain text, with one link to manage it in web settings', async () => {
    // Purpose: fails if an owner sees inputs, is promised a way to manage here that does not
    // exist yet, or the link is missing or repeated.
    mount('owner');
    expect(await screen.findByText('You’re the owner', { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    const general = screen.getByTestId('space-settings-general');
    expect(within(general).getByText('Invite only')).toBeInTheDocument();
    const manage = within(general).getAllByRole('link', { name: /Manage this in web settings/ });
    expect(manage).toHaveLength(1);
    expect(manage[0]).toHaveAttribute(
      'href',
      `https://spaces.example/c/${connection.remoteCommunityId}/settings/community`
    );
    expect(screen.queryByText(/Pair again/)).not.toBeInTheDocument();
    const members = screen.getByTestId('space-settings-members');
    expect(
      within(members).getAllByRole('link', { name: /Manage this in web settings/ })[0]
    ).toHaveAttribute(
      'href',
      `https://spaces.example/c/${connection.remoteCommunityId}/settings/members`
    );
    expect(screen.getByText('Invite links and mutes')).toBeInTheDocument();
  });

  it('lists people with roles as text and their agents under them', async () => {
    mount('owner');
    const members = await screen.findByTestId('space-settings-members');
    expect(await within(members).findByText('2 people · 1 agent')).toBeInTheDocument();
    const alex = within(members).getByText('Alex Kim').closest('li')!;
    expect(within(alex).getByText('Owner')).toBeInTheDocument();
    expect(within(alex).getByText('Scout')).toBeInTheDocument();
    expect(within(alex).getByText('Available')).toBeInTheDocument();
    expect(within(members).getByRole('button', { name: /Invite/ })).toBeDisabled();
  });

  it('hands transfer, archive and delete to the web settings, and cannot leave', async () => {
    // Purpose: fails if the last owner is offered Leave, or a destructive act runs in the app.
    mount('owner');
    await screen.findByText('You’re the owner', { exact: false });
    const danger = screen.getByTestId('space-settings-danger');
    expect(within(danger).getByText('Make someone else an owner first.')).toBeInTheDocument();
    const links = within(danger).getAllByRole('link', { name: /Continue in web settings/ });
    expect(links).toHaveLength(3);
    for (const link of links)
      expect(link).toHaveAttribute(
        'href',
        `https://spaces.example/c/${connection.remoteCommunityId}/settings/community`
      );
    expect(screen.getByText(/Also on the web/)).toBeInTheDocument();
  });
});

describe('an admin', () => {
  it('manages through the web settings, and may leave there too', async () => {
    mount('admin');
    expect(await screen.findByText('You’re an admin', { exact: false })).toBeInTheDocument();
    const danger = screen.getByTestId('space-settings-danger');
    expect(within(danger).getByRole('link', { name: /Continue in web settings/ })).toHaveAttribute(
      'href',
      `https://spaces.example/c/${connection.remoteCommunityId}/settings/account`
    );
    expect(within(danger).queryByText('Archive')).not.toBeInTheDocument();
  });
});

describe('a member', () => {
  it('sees who can change each value, row by row, and no admin rows', async () => {
    // Purpose: fails if a member is sent to manage what they cannot change anyway.
    mount('member');
    expect(await screen.findByText('Only the owner can rename the space.')).toBeInTheDocument();
    expect(
      screen.getByText('Ask an owner or admin to invite or remove people.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Manage this in web settings/ })).toBeNull();
    expect(screen.queryByText('Invite links and mutes')).not.toBeInTheDocument();
    expect(await screen.findByText('You agreed to version 3.')).toBeInTheDocument();
  });

  it('shows the space’s own reason when it keeps its directory to owners and admins', async () => {
    // Purpose: fails if a refused directory reads as an error instead of a plain reason.
    mount('member', {
      refuse: { members: 'This space doesn’t show who is in it to your role.' },
    });
    expect(
      await screen.findByText('This space doesn’t show who is in it to your role.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('a space that cannot be reached', () => {
  it('shows the last values, one amber line with Try again, and no reasons of its own', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T10:00:00.000Z') });
    try {
      mount('owner', { offline: true });
      expect(
        await screen.findByText(
          'Can’t reach spaces.example. These are the settings from 2 hours ago.'
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(screen.getByText('Offline')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Manage this in web settings/ })).toBeNull();
      expect(screen.getAllByText('Northwind Studio').length).toBeGreaterThan(0);
      expect(screen.queryAllByRole('link', { name: /Continue in web settings/ })).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the private space', () => {
  it('is just you and your agents, with no invite, roles, rules or web page', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.listMeshAgents).mockResolvedValue({
      agents: [{ id: 'agent-1', name: 'Chief of Staff' }] as never,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TransportProvider transport={transport}>
          <PrivateSpaceSettings />
        </TransportProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText('Chief of Staff')).toBeInTheDocument();
    expect(screen.getByText('Just you and your agents')).toBeInTheDocument();
    expect(screen.getByText('You and 1 agent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Invite/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Rules')).not.toBeInTheDocument();
    expect(screen.queryByText(/Also on the web/)).not.toBeInTheDocument();
    expect(
      screen.getByText('Your private space can’t be left or deleted. It goes with your account.')
    ).toBeInTheDocument();
  });
});
