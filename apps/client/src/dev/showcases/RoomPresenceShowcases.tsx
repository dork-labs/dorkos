/**
 * The line that says who is working, with no server behind it.
 *
 * Presence is ephemeral and never replays, so the only way to reach these
 * states is to publish signals the way the server does — including the 10s
 * republish, without which every line here would expire after 30 seconds and
 * the showcase would quietly go blank (spec `identity-consistency` §W4.3).
 *
 * @module dev/showcases/RoomPresenceShowcases
 */
import { useEffect } from 'react';
import type { RoomPresenceState, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { useRoomPresenceStore } from '@/layers/entities/room';
// By path rather than through the slice's barrel, the same way the room
// showcases reach `RoomMemberRow`: the line takes a room and its roster and
// means nothing outside the room view that owns them, so putting it on the
// widget's public API would advertise a component nothing else may render.
import { RoomPresenceLine } from '@/layers/widgets/room-view/ui/RoomPresenceLine';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MEMBER } from './rooms-showcase-data';

/** How often the server restates every live claim. Below the 30s expiry. */
const REPUBLISH_MS = 10_000;

/** One agent's claim in one demo room. */
interface Claim {
  member: RoomRosterEntry;
  state: Exclude<RoomPresenceState, 'done'>;
  /** How long it has been running, so the elapsed time reads as a real wait. */
  minutesIn: number;
}

/** One demo: a room of its own, so its claims cannot leak into another line. */
interface PresenceDemo {
  roomId: string;
  label: string;
  claims: readonly Claim[];
}

const DEMOS: readonly PresenceDemo[] = [
  {
    roomId: 'presence-one',
    label: 'One agent, and how long the room has been waiting',
    claims: [{ member: MEMBER.pm, state: 'working', minutesIn: 3 }],
  },
  {
    roomId: 'presence-late',
    label: 'Past the point the room stopped waiting — the same line, said differently',
    claims: [{ member: MEMBER.code, state: 'working_late', minutesIn: 12 }],
  },
  {
    roomId: 'presence-three',
    label: 'Three at once — still named, because a room this size can hold the names',
    claims: [
      { member: MEMBER.pm, state: 'working', minutesIn: 4 },
      { member: MEMBER.code, state: 'working', minutesIn: 2 },
      { member: MEMBER.kai, state: 'working', minutesIn: 1 },
    ],
  },
  {
    roomId: 'presence-many',
    label: 'More than it will name — counted, and the count opens the list',
    claims: [
      { member: MEMBER.pm, state: 'working', minutesIn: 6 },
      { member: MEMBER.code, state: 'working', minutesIn: 5 },
      { member: MEMBER.kai, state: 'working_late', minutesIn: 3 },
      { member: MEMBER.unresolved, state: 'working', minutesIn: 1 },
    ],
  },
];

/** Every roster the demos draw names from. */
const ROSTERS: Record<string, RoomRosterEntry[]> = Object.fromEntries(
  DEMOS.map((demo) => [demo.roomId, demo.claims.map((claim) => claim.member)])
);

/**
 * Publish the fixture's claims, and keep publishing them.
 *
 * The store is a liveness cache with a 30-second expiry, so a one-shot seed
 * would draw four lines that vanished while the page was still open. Restating
 * them on the server's own cadence is what makes the showcase honest rather
 * than a still. `since` never moves, so the elapsed time really does count up.
 */
function usePresenceFixture(): void {
  useEffect(() => {
    const publish = () => {
      const store = useRoomPresenceStore.getState();
      for (const demo of DEMOS) {
        for (const claim of demo.claims) {
          store.observe(demo.roomId, {
            type: 'signal',
            signal: 'progress',
            authorId: claim.member.authorId,
            at: new Date().toISOString(),
            state: claim.state,
            entryId: `${demo.roomId}-${claim.member.authorId}`,
            since: new Date(Date.now() - claim.minutesIn * 60_000).toISOString(),
          });
        }
      }
    };
    publish();
    const timer = setInterval(publish, REPUBLISH_MS);
    return () => {
      clearInterval(timer);
      const store = useRoomPresenceStore.getState();
      for (const demo of DEMOS) store.clearRoom(demo.roomId);
    };
  }, []);
}

/** The room's live working line, in each of the shapes it takes. */
export function RoomPresenceLineShowcase() {
  usePresenceFixture();

  return (
    <PlaygroundSection
      title="RoomPresenceLine"
      description="The line under a room's composer that says who is working, counting up from when the work started. It is absent — not empty — when nobody is, so a quiet room looks quiet. Past four agents it stops naming them and counts instead; press the count to see the list. The elapsed times below are live: these claims are republished on the server's own ten-second cadence, because presence expires rather than persists."
    >
      {DEMOS.map((demo) => (
        <div key={demo.roomId}>
          <ShowcaseLabel>{demo.label}</ShowcaseLabel>
          <ShowcaseDemo>
            <div className="bg-card w-full max-w-md rounded-lg border py-2">
              <RoomPresenceLine roomId={demo.roomId} members={ROSTERS[demo.roomId]!} />
            </div>
          </ShowcaseDemo>
        </div>
      ))}

      <ShowcaseLabel>Nobody working — the line is gone, not blank</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-card w-full max-w-md rounded-lg border py-2">
          <RoomPresenceLine roomId="presence-quiet" members={[]} />
          <p className="text-muted-foreground px-4 text-xs italic">
            (this box is the composer&apos;s footprint — no strip of reserved space above it)
          </p>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
