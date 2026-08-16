import { useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { Button } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { ProfileSheet, profileStack, type ProfilePageId } from '@/layers/features/profile';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MOCK_TEAM_ROSTER } from '../mock-samples';
import { createPlaygroundTransport } from '../playground-transport';

/**
 * A local teammate, which the shared roster has none of — Miguel is bridged in
 * over Telegram, and "another person" is a different profile (their rows are
 * readable, not editable, and they manage agents of their own).
 */
const PRIYA: TeamMember = {
  id: 'person-priya',
  kind: 'human',
  displayName: 'Priya',
  handle: 'priya',
  color: '#b45309',
  isSelf: false,
  ownerId: null,
  origin: 'local',
  person: {
    role: 'Staff architect',
    lastSeenAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  },
};

/** The roster the six states are drawn against. */
const FIXTURE_ROSTER: TeamMember[] = [
  // Someone else's agent, so the cartographer's owner is on the roster.
  ...MOCK_TEAM_ROSTER.map((member) =>
    member.id === 'agent-cartographer' ? { ...member, ownerId: PRIYA.id } : member
  ),
  PRIYA,
];

const byId = (id: string): TeamMember => FIXTURE_ROSTER.find((member) => member.id === id)!;

/** The six relationships, in the order `design/05-states-final.html` draws them. */
const STATES: { id: string; label: string; page?: ProfilePageId }[] = [
  { id: 'person-dorian', label: 'You' },
  { id: 'person-priya', label: 'Another person' },
  { id: 'person-miguel', label: 'Someone via Telegram' },
  { id: 'agent-warden', label: 'Your agent' },
  { id: 'agent-cartographer', label: 'Someone else’s agent' },
  { id: 'agent-dorkbot', label: 'DorkBot' },
  { id: 'person-dorian', label: 'Pushed page: Manages', page: 'manages' },
  { id: 'agent-warden', label: 'Pushed page: Sessions', page: 'sessions' },
  { id: 'agent-warden', label: 'Pushed page: Instructions', page: 'instructions' },
];

/**
 * The manifest the pushed pages read.
 *
 * The playground has no agent on disk, so without this the pages that open a
 * manifest — About, Instructions, Boundaries, Appearance — draw their "couldn't
 * read this" branch, which is a state worth having but a poor demo of a page.
 */
const FIXTURE_MANIFEST = {
  id: 'agent-warden',
  name: 'warden',
  displayName: 'Warden',
  description: 'Watches the build and says something when it breaks.',
  capabilities: ['review', 'triage'],
  runtime: 'claude-code',
  traits: { verbosity: 3, autonomy: 3, chaos: 3, creativity: 3, humor: 3, spice: 3 },
  conventions: { soul: true, nope: true, dorkosKnowledge: true },
  behavior: { responseMode: 'always' },
  enabledToolGroups: {},
  mcpServers: [],
  soulContent:
    '<!-- TRAITS:START -->\ntraits\n<!-- TRAITS:END -->\nSay what broke before you say how to fix it.',
  nopeContent: 'Never force-push to a shared branch.',
} as unknown as AgentManifest;

/**
 * The playground's transport, with one answer filled in.
 *
 * Everything else stays `null` (`createPlaygroundTransport`), which is what
 * gives the Sessions, Tasks and Skills pages their honest empty states.
 */
function useFixtureTransport(): Transport {
  return useMemo(() => {
    const base = createPlaygroundTransport();
    return new Proxy(base, {
      get: (target, prop) =>
        prop === 'getAgentByPath' ? async () => FIXTURE_MANIFEST : Reflect.get(target, prop),
    });
  }, []);
}

/** The profile's own cache and transport, so a showcase never writes the real ones. */
function Fixture({ children }: { children: ReactNode }) {
  const transport = useFixtureTransport();
  const queryClient = useMemo(() => new QueryClient(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * Showcases for the one Profile: the same component for every identity.
 *
 * Opening one here draws it exactly as the app does — a right-side sheet on a
 * pointer, full-screen below 768px. Narrow the browser to see the second.
 */
export function ProfileShowcases() {
  const [openState, setOpenState] = useState<(typeof STATES)[number] | null>(null);
  const member = openState ? byId(openState.id) : undefined;

  return (
    <PlaygroundSection
      title="Profile"
      description="One panel for any identity, in the six shapes it takes: your own row, another person, somebody bridged in over Telegram, an agent you manage, an agent somebody else manages, and DorkBot. What changes between them is which facts are true — the status line, who is above the button, whether the button exists at all, and which rows have arrows. Two things this fixture invents: a second local person, so the 'another person' rows have somebody to be about, and one agent manifest, so the pushed pages have a file and a description to draw. Nothing else is answered, which is why the Sessions and Tasks pages show their empty states."
    >
      <ShowcaseLabel>The six relationships, and three pushed pages</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap gap-2">
          {STATES.map((state) => (
            <Button key={state.label} variant="outline" onClick={() => setOpenState(state)}>
              {state.label}
            </Button>
          ))}
        </div>
        {member && openState && (
          <Fixture>
            <ProfileSheet
              member={member}
              roster={FIXTURE_ROSTER}
              open
              onOpenChange={(open) => !open && setOpenState(null)}
              stack={profileStack(
                member.id,
                openState.page ? [{ kind: 'page', page: openState.page }] : []
              )}
              // The playground mounts no router, so a chained profile swaps the
              // fixture in place rather than writing a URL nothing is reading.
              onPush={(entry) =>
                entry.kind === 'profile'
                  ? setOpenState({ id: entry.memberId, label: entry.memberId })
                  : setOpenState({ ...openState, page: entry.page })
              }
              onPop={() => setOpenState({ ...openState, page: undefined })}
            />
          </Fixture>
        )}
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
