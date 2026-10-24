/**
 * A space's Settings tab (DOR-3005) in each state a person can be in: owner, admin, member, a
 * member of a space that keeps its directory to owners and admins, a space that cannot be
 * reached, and the private space on a hub.
 *
 * The REAL panels, each over a stub transport that answers the four reads the way the local
 * server would, so the copy, grouping and locks are the ones the app draws.
 *
 * @module dev/showcases/SpaceSettingsShowcases
 */
import { useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import type { CommunitySpaceRead } from '@dorkos/shared/community-space-settings';
import { PrivateSpaceSettings, SpaceSettingsPanel } from '@/layers/features/space-settings';
import {
  confirmCommunityAuthority,
  getCommunityAuthority,
  invalidateCommunityAuthority,
} from '@/layers/shared/lib';
import { TransportProvider, useTransport } from '@/layers/shared/model';
import type { Transport } from '@dorkos/shared/transport';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

const REMOTE_ID = '7c1e2a40-5b7d-4f0e-9a51-2f6d8b3c4e10';
const CONNECTION = {
  ref: 'northwind',
  remoteCommunityId: REMOTE_ID,
  label: 'Northwind Studio',
  pinnedOrigin: 'https://spaces.example.com',
  connectedHumanMemberId: 'm-alex',
  status: 'connected',
  expiresAt: null,
  access: null,
  attention: null,
} as unknown as CommunityConnectionDescriptor;

const person = (id: string, name: string, role: 'owner' | 'admin' | 'member') => ({
  memberId: id,
  kind: 'human' as const,
  displayName: name,
  handle: name.split(' ')[0]!.toLowerCase(),
  role,
  ownerMemberId: null,
});
const agent = (
  id: string,
  name: string,
  owner: string,
  availability: 'available' | 'offline' | 'unknown',
  lastSeenAt: string | null = null
) => ({
  memberId: id,
  kind: 'agent' as const,
  displayName: name,
  handle: id,
  role: null,
  ownerMemberId: owner,
  runsOn: 'computer' as const,
  lastSeenAt,
  availability,
});

const HOURS_AGO = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function values(role: 'owner' | 'admin' | 'member') {
  return {
    settings: {
      communityId: REMOTE_ID,
      name: 'Northwind Studio',
      description: 'Where the Northwind team plans launches, reviews designs and keeps its agents.',
      admissionPolicy: 'invite_only',
      hasIcon: false,
      settingsVersion: 3,
      lifecycle: 'active',
      lifecycleVersion: 1,
    },
    me: { member: { ...person('m-alex', 'Alex Kim', role), joinedAt: HOURS_AGO(400) } },
    members: {
      members: [
        person('m-alex', 'Alex Kim', role),
        person('m-maya', 'Maya Chen', role === 'owner' ? 'admin' : 'owner'),
        person('m-jordan', 'Jordan Okafor', 'member'),
        person('m-priya', 'Priya Raman', 'admin'),
      ],
      agents: [
        agent('scout', 'Scout', 'm-alex', 'available'),
        agent('ledger', 'Ledger', 'm-maya', 'offline', HOURS_AGO(1.5)),
        agent(
          'research',
          'Research assistant for the Q4 partner newsletter',
          'm-jordan',
          'available'
        ),
      ],
      nextCursor: null,
    },
    rules: {
      text: 'Be kind, be direct. Critique the work, not the person.\nAgents post in #launch-week only when asked.\nNo client names outside private channels.',
      version: 3,
      acceptedVersion: 3,
    },
  };
}

interface DemoState {
  role: 'owner' | 'admin' | 'member';
  offline?: boolean;
  refuseMembers?: boolean;
}

/** Hold a confirmed playground owner, so the space's reads run as they do in the app. */
function confirmOwner(): void {
  if (getCommunityAuthority().ownerKey !== null) return;
  const next = invalidateCommunityAuthority();
  confirmCommunityAuthority(next.epoch, 'playground-owner');
}

/** The playground transport, answering this space's reads for one state. */
function useStubTransport(state: DemoState): Transport {
  const base = useTransport();
  return useMemo(
    () =>
      new Proxy(base, {
        get(target, key, receiver) {
          // Spaces on, so the owner's authority over the connection is confirmed as in the app.
          if (key === 'getConfig')
            return async () => ({
              ...(await target.getConfig()),
              experiments: [
                {
                  key: 'spaces.enabled',
                  title: 'Spaces',
                  description: 'Spaces',
                  enabled: true,
                  lockedByEnv: false,
                },
              ],
            });
          if (key === 'getCommunityNavigation')
            return async () => ({
              ownerKey: getCommunityAuthority().ownerKey ?? 'playground-owner',
              order: [],
              destinations: [],
            });
          if (key === 'readCommunitySpace')
            return async (_ref: string, read: CommunitySpaceRead) => {
              if (read === 'members' && state.refuseMembers)
                throw Object.assign(
                  new Error('This space doesn’t show who is in it to your role.'),
                  { status: 403 }
                );
              return {
                value: values(state.role)[read],
                fetchedAt: state.offline ? HOURS_AGO(2) : new Date().toISOString(),
                offline: state.offline === true,
              };
            };
          if (key === 'listMeshAgents')
            return async () => ({
              agents: [
                { id: 'chief', name: 'Chief of Staff' },
                { id: 'scout', name: 'Scout' },
                { id: 'inbox', name: 'Inbox sorter' },
              ],
            });
          return Reflect.get(target, key, receiver);
        },
      }),
    [base, state]
  );
}

/** The private space's demo reads no space; this keeps its stub transport stable. */
const PRIVATE_STUB: DemoState = { role: 'owner' };

function Demo({ state, testId }: { state: DemoState | 'private'; testId: string }) {
  const transport = useStubTransport(state === 'private' ? PRIVATE_STUB : state);
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <div className="bg-background rounded-md" data-testid={testId}>
          {state === 'private' ? (
            <PrivateSpaceSettings />
          ) : (
            <SpaceSettingsPanel connection={CONNECTION} />
          )}
        </div>
      </TransportProvider>
    </QueryClientProvider>
  );
}

const STATES: ReadonlyArray<{ id: string; label: string; state: DemoState | 'private' }> = [
  { id: 'owner', label: 'Owner — read-only here, told to pair again', state: { role: 'owner' } },
  { id: 'admin', label: 'Admin', state: { role: 'admin' } },
  { id: 'member', label: 'Member — one read-only reason', state: { role: 'member' } },
  {
    id: 'member-directory-refused',
    label: 'Member of a space that keeps its directory to owners and admins',
    state: { role: 'member', refuseMembers: true },
  },
  {
    id: 'offline',
    label: 'Offline — the last values, two hours old',
    state: { role: 'owner', offline: true },
  },
  { id: 'private', label: 'Private space on a hub', state: 'private' },
];

/** A space's Settings tab, in each of its states. */
export function SpaceSettingsShowcases() {
  useState(confirmOwner);
  return (
    <PlaygroundSection
      title="SpaceSettingsPanel"
      description="A space’s Settings tab: General, Members, Rules and the ways out, read through the app’s own pairing. Check that (a) nothing looks like a disabled input, (b) each reason appears once, and (c) the offline line names how old the values are."
    >
      <div className="space-y-6">
        {STATES.map((item) => (
          <div key={item.id} className="space-y-2">
            <ShowcaseLabel>{item.label}</ShowcaseLabel>
            <ShowcaseDemo responsive>
              <Demo state={item.state} testId={`space-settings-demo-${item.id}`} />
            </ShowcaseDemo>
          </div>
        ))}
      </div>
    </PlaygroundSection>
  );
}
