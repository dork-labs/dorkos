import { useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { HeartbeatStatus } from '@dorkos/shared/heartbeat-schemas';
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
  { id: 'agent-warden', label: 'Pushed page: Memory', page: 'memory' },
  { id: 'agent-warden', label: 'Pushed page: Heartbeat', page: 'heartbeat' },
];

/**
 * The manifest the pushed pages read.
 *
 * The playground has no agent on disk, so without this the pages that open a
 * manifest — About, Instructions, Boundaries, Memory, Appearance — draw their "couldn't
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
  conventions: { soul: true, nope: true, memory: true, dorkosKnowledge: true },
  behavior: { responseMode: 'always' },
  mcpServers: [],
  soulContent:
    '<!-- TRAITS:START -->\ntraits\n<!-- TRAITS:END -->\nSay what broke before you say how to fix it.',
  nopeContent: 'Never force-push to a shared branch.',
  memoryContent:
    '- The build is deployed on Tuesdays. (noted in #product, 2026-08-24)\n- Dorian prefers the failure before the fix. (noted in a direct chat, 2026-08-24)',
  heartbeatContent:
    '---\nname: heartbeat\nwake: timed\nreport: daily\n---\n\n- A red build on main comes first.\n- Never retry a deploy unasked.',
} as unknown as AgentManifest;

/**
 * What the Heartbeat page reads: a timed agent with a check due soon, three
 * past checks that ended three different ways, and one message held overnight.
 */
function fixtureHeartbeat(): HeartbeatStatus {
  const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  return {
    enabled: true,
    wake: 'timed',
    nextBeatAt: minutesFromNow(12),
    skippedReason: null,
    fileError: null,
    lastBeats: [
      {
        id: 'beat-3',
        startedAt: minutesFromNow(-18),
        endedAt: minutesFromNow(-17),
        kind: 'pulse',
        wake: 'event:run.failed',
        outcome: 'worked',
        summary: 'Main went red on a flaky test. Reran it; green again.',
        raises: 1,
        sessionId: 'beat-chat-today',
      },
      {
        id: 'beat-2',
        startedAt: minutesFromNow(-48),
        endedAt: minutesFromNow(-48),
        kind: 'pulse',
        wake: 'timer',
        outcome: 'quiet',
        summary: 'Checked 4 things. Nothing new.',
        raises: 0,
        sessionId: null,
      },
      {
        id: 'beat-1',
        startedAt: minutesFromNow(-200),
        endedAt: minutesFromNow(-195),
        kind: 'pulse',
        wake: 'timer',
        outcome: 'no-end-beat',
        summary: '',
        raises: 0,
        sessionId: 'beat-chat-today',
      },
    ],
    held: [
      {
        id: 'held-1',
        to: 'owner',
        rung: 'dm',
        text: 'Main was red for 20 minutes this afternoon. A rerun fixed it.',
        deliverAfter: minutesFromNow(15 * 60),
        createdAt: minutesFromNow(-17),
      },
    ],
    report: { cadence: 'daily', to: 'owner', nextReportAt: minutesFromNow(15 * 60), items: 3 },
    // The credits offer stands, so the showcase draws its card.
    checks: { runsOn: 'runtime', runtime: 'claude-code', today: 0, tokens: 0, offer: true },
  };
}

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
      get: (target, prop) => {
        if (prop === 'getAgentByPath') return async () => FIXTURE_MANIFEST;
        if (prop === 'getAgentHeartbeat') return async () => fixtureHeartbeat();
        return Reflect.get(target, prop);
      },
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
      description="One panel for any identity, in the six shapes it takes: your own row, another person, somebody bridged in over Telegram, an agent you manage, an agent somebody else manages, and DorkBot. What changes between them is which facts are true — the status line, who is above the button, whether the button exists at all, and which rows have arrows. Two things this fixture invents: a second local person, so the 'another person' rows have somebody to be about, and one agent manifest, so the pushed pages have a file and a description to draw. Little else is answered, which is why the Sessions and Tasks pages show their empty states. The Instructions and Memory pages carry the injected-prompt preview: open it to read what the agent is actually handed — identity, personality, both convention files, and the agent's own saved notes inside the fence a turn puts them in, assembled the way the server assembles them and following the draft rather than the file on disk. The Heartbeat page is answered too: a timed agent, three past checks that ended three ways, one message held for the morning, and a report with three items so far."
    >
      <ShowcaseLabel>The six relationships, and five pushed pages</ShowcaseLabel>
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
