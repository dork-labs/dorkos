import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { findTeamOwner } from '@/layers/entities/team';
import { TeamMemberCard, TeamRosterSkeleton } from '@/layers/features/team-roster';
import { TeamPage } from '@/layers/widgets/team';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MOCK_TEAM_ROSTER, withSuggestedName } from '../mock-samples';
import { createPlaygroundTransport } from '../playground-transport';

const byId = (id: string): TeamMember => MOCK_TEAM_ROSTER.find((member) => member.id === id)!;

/** The operator's own row — the only one a provenance note is ever drawn on. */
const SELF = MOCK_TEAM_ROSTER.find((member) => member.isSelf)!;

/**
 * The playground's Transport answers `null` for everything, which a page that
 * reads a roster cannot render. Overriding the one method here — rather than
 * teaching the shared playground transport about the roster — keeps the fixture
 * beside the showcase that shows it.
 */
function useRosterTransport(members: TeamMember[]): Transport {
  return useMemo(() => {
    // A Proxy rather than a spread: the playground's transport is itself a
    // Proxy with no own keys, so spreading it would quietly produce an object
    // with exactly one method and break the first component to call a second.
    const base = createPlaygroundTransport();
    return new Proxy(base, {
      get: (target, prop, receiver) =>
        prop === 'getTeamRoster'
          ? () => Promise.resolve({ members })
          : Reflect.get(target, prop, receiver),
    });
  }, [members]);
}

/**
 * A row of cards from the fixture.
 *
 * Its own element rather than a `className` on `ShowcaseDemo`: the demo wraps
 * its children in a viewport-width div, so a grid declared out there would have
 * exactly one grid item.
 */
function CardRow({ ids }: { ids: string[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {ids.map((id) => {
        const member = byId(id);
        return (
          <TeamMemberCard
            key={id}
            member={member}
            owner={findTeamOwner(member, MOCK_TEAM_ROSTER)}
            onSelectOwner={() => undefined}
          />
        );
      })}
    </div>
  );
}

/** The real Team page, driven by the fixture, with its own cache. */
function TeamPageDemo({ members }: { members: TeamMember[] }) {
  const transport = useRosterTransport(members);
  // Its own client, so flipping between the two demos below does not serve one
  // fixture's roster from the other's cache — both are keyed `['team']`.
  const queryClient = useMemo(() => new QueryClient(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <div className="h-[32rem] overflow-hidden rounded-lg border">
          <TeamPage />
        </div>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** Showcases for the `/team` roster: the whole page, and the card it is made of. */
export function TeamShowcases() {
  const peopleOnly = useMemo(
    () => MOCK_TEAM_ROSTER.filter((member) => member.kind === 'human'),
    []
  );

  return (
    <>
      <PlaygroundSection
        title="Team Roster"
        description="Every person and agent on this install, in one grid. Driven by a two-people / four-agent / two-owner fixture the product cannot produce yet — the shape the cards, chips and grouping have to already work for. Try the chips, the search, an agent's 'by @handle' attribution, and Group by owner."
      >
        <ShowcaseLabel>Two people, four agents, two owners</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <TeamPageDemo members={MOCK_TEAM_ROSTER} />
        </ShowcaseDemo>

        <ShowcaseLabel>No agents yet — the roster still is not empty</ShowcaseLabel>
        <ShowcaseDemo>
          <TeamPageDemo members={peopleOnly} />
        </ShowcaseDemo>

        <ShowcaseLabel>
          Loading — mirrors TeamMemberCard&rsquo;s own dimensions so the grid does not jump when the
          real roster lands (batch 06, finding 6.5)
        </ShowcaseLabel>
        <ShowcaseDemo>
          <TeamRosterSkeleton />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Team Card"
        description="One identity on the roster. The disc is derived from kind — a filled square with a Bot mark for an agent, a circle for a person, a platform mark for someone bridged in — so a card cannot draw an agent as a person by forgetting a prop."
      >
        <ShowcaseLabel>The operator, an owned agent, and someone bridged in</ShowcaseLabel>
        <ShowcaseDemo>
          <CardRow ids={['person-dorian', 'agent-warden', 'person-miguel']} />
        </ShowcaseDemo>

        <ShowcaseLabel>A long name, no handle, and an agent nobody owns</ShowcaseLabel>
        <ShowcaseDemo>
          <CardRow ids={['agent-cartographer', 'agent-dorkbot']} />
        </ShowcaseDemo>

        <ShowcaseLabel>
          A name an agent suggested (DOR-1022) — drawn only on your own row, and only until you save
          a name yourself in Settings › Profile. The third card is the common state, for contrast:
          no note is the normal case, and a name this install has no record of gets none either.
        </ShowcaseLabel>
        <ShowcaseDemo>
          <div className="grid gap-3 md:grid-cols-3">
            <TeamMemberCard member={withSuggestedName(SELF, 'DorkBot')} />
            <TeamMemberCard member={withSuggestedName(SELF, null)} />
            <TeamMemberCard member={SELF} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
