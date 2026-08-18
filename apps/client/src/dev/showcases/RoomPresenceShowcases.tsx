/**
 * The live lane when somebody is working, with no server behind it.
 *
 * It draws the REAL `Conversation.LiveLane`, driven by a `LaneState` the same
 * pure function the product uses builds from a fixture. The claims are handed
 * straight to `deriveLaneState` rather than published into the presence store:
 * the store is a liveness cache that expires after thirty seconds, so a seeded
 * showcase used to need a republish loop to stop going blank while the page was
 * open. Its output is a `LaneState`, so a fixture is the honest input.
 *
 * @module dev/showcases/RoomPresenceShowcases
 */
import {
  Conversation,
  deriveLaneState,
  NO_ASKS,
  type LanePresenceAuthor,
} from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '@/layers/widgets/room-view';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MEMBER } from './rooms-showcase-data';

/** One agent's claim in one demo. */
interface Claim {
  name: string;
  authorId: string;
  state: LanePresenceAuthor['state'];
  /** How long it has been running, so the elapsed time reads as a real wait. */
  minutesIn: number;
}

/** One demo line. */
interface PresenceDemo {
  id: string;
  label: string;
  claims: readonly Claim[];
}

/** Turn a roster member into a claim of a given age. */
function claim(
  member: (typeof MEMBER)[keyof typeof MEMBER],
  state: LanePresenceAuthor['state'],
  minutesIn: number
): Claim {
  return { name: member.author.displayName, authorId: member.authorId, state, minutesIn };
}

const DEMOS: readonly PresenceDemo[] = [
  {
    id: 'one',
    label: 'One agent, and how long the room has been waiting',
    claims: [claim(MEMBER.pm, 'working', 3)],
  },
  {
    id: 'late',
    label: 'Past the point the room stopped waiting — the same line, said differently',
    claims: [claim(MEMBER.code, 'working_late', 12)],
  },
  {
    id: 'three',
    label: 'Three at once — still named, because a line this size can hold the names',
    claims: [
      claim(MEMBER.pm, 'working', 4),
      claim(MEMBER.code, 'working', 2),
      claim(MEMBER.kai, 'working', 1),
    ],
  },
  {
    id: 'many',
    label: 'More than it will name — counted, and the peek behind it holds the list',
    claims: [
      claim(MEMBER.pm, 'working', 6),
      claim(MEMBER.code, 'working', 5),
      claim(MEMBER.kai, 'working_late', 3),
      claim(MEMBER.unresolved, 'working', 1),
    ],
  },
];

/** The lane's presence state for one demo, built the way the product builds it. */
function laneStateFor(demo: PresenceDemo) {
  return deriveLaneState({
    capabilities: ROOM_CAPABILITIES,
    asks: NO_ASKS,
    stalled: false,
    presence: demo.claims.map((entry) => ({
      authorId: entry.authorId,
      name: entry.name,
      state: entry.state,
      since: new Date(Date.now() - entry.minutesIn * 60_000).toISOString(),
    })),
    turn: null,
    queueDepth: 0,
  });
}

/** The live lane's presence rung, in each of the shapes it takes. */
export function LiveLanePresenceShowcase() {
  return (
    <PlaygroundSection
      title="Live lane presence"
      description="The line above a room's composer that says who is working, counting up from when the work started. It is a fixed 24 pixels whether or not anything is happening, so an agent picking something up moves nothing already on screen — and it draws nothing at all when the room is quiet, so a quiet room still looks quiet. Past three agents it stops naming them and counts instead. The elapsed times below are live and start at ten seconds: a timer that begins at zero draws the eye for nothing."
    >
      {DEMOS.map((demo) => (
        <div key={demo.id}>
          <ShowcaseLabel>{demo.label}</ShowcaseLabel>
          <ShowcaseDemo>
            <div className="bg-card w-full max-w-md rounded-lg border py-2">
              <Conversation.LiveLane state={laneStateFor(demo)} />
            </div>
          </ShowcaseDemo>
        </div>
      ))}

      <ShowcaseLabel>Nobody working — the line is blank, and still exactly as tall</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-card w-full max-w-md rounded-lg border py-2">
          <Conversation.LiveLane state={{ kind: 'empty' }} />
          <p className="text-muted-foreground px-4 text-xs italic">
            (the 24 pixels above this line are the lane, holding its place)
          </p>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
