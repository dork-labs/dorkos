import { PresenceStrip, type PresenceRow } from '@/layers/features/presence-strip';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/**
 * Frozen at module load, not read per render: `Date.now()` during render is
 * impure (`react-hooks/purity`), and durations that shift under the pointer are
 * harder to read anyway. Same shape as `TriageHeaderShowcases`.
 */
const LOADED_AT = Date.now();

/**
 * A row as `buildPresenceRows` produces one.
 *
 * The copy is spelled out here rather than recomputed, because a showcase that
 * ran the real copy helpers would hide a change in them: the point of these
 * demos is to see the sentences, not to trust them.
 */
function row(overrides: Partial<PresenceRow>): PresenceRow {
  return {
    id: 'room:room-1:author-1',
    name: 'tangerines',
    handle: 'tangerines',
    face: { kind: 'agent', color: '#f97316', emoji: '🍊', fallback: 'T' },
    binding: 'replying in #release-train',
    state: 'working',
    since: new Date(LOADED_AT - 42_000).toISOString(),
    roomTitle: '#release-train',
    runtime: 'claude-code',
    line: 'tangerines · replying in #release-train',
    detail: 'replying in #release-train',
    follow: { kind: 'room', roomId: 'room-1' },
    ...overrides,
  };
}

const REPLYING = row({});

const LATE = row({
  id: 'room:room-1:author-2',
  name: 'Meeting Notes',
  handle: 'meeting-notes',
  face: { kind: 'agent', color: '#22d3ee', emoji: '🗒️', fallback: 'M' },
  state: 'working_late',
  since: new Date(LOADED_AT - 22 * 60_000).toISOString(),
  line: 'Meeting Notes · replying in #release-train · taking longer than usual',
  detail: 'replying in #release-train · taking longer than usual',
});

const IN_SESSION = row({
  id: 'session:sess-1',
  name: 'DorkBot',
  handle: 'dorkbot',
  face: { kind: 'agent', color: '#6366f1', emoji: '🤖', fallback: 'D' },
  binding: 'working in a session',
  detail: 'working in a session',
  line: 'DorkBot · working in a session',
  since: null,
  roomTitle: null,
  follow: { kind: 'session', sessionId: 'sess-1', cwd: '/code/dorkbot' },
});

const NO_BINDING = row({
  id: 'room:room-2:author-3',
  name: 'warden',
  handle: 'warden',
  face: { kind: 'agent', color: '#a3e635', emoji: '🛡️', fallback: 'W' },
  binding: null,
  detail: null,
  line: 'warden',
  roomTitle: null,
  follow: { kind: 'room', roomId: 'room-2' },
});

/**
 * Twelve agents working at once — the state that made the header four lines
 * tall before the cap, and the one to look at on a narrow window.
 */
const BUSY_FLEET: PresenceRow[] = Array.from({ length: 12 }, (_, index) =>
  row({
    id: `room:room-1:author-${index}`,
    name: `agent-${index}`,
    line: `agent-${index} · replying in #release-train`,
  })
);

/**
 * The presence strip in the states a real cockpit reaches — including the two
 * that are only interesting because of what they refuse to say.
 *
 * Drawn from rows rather than from live presence: every state below depends on
 * a claim starting or ending at a particular moment, and the honest ones (an
 * agent nothing can place, a wait that has gone long) cannot be asked for.
 */
export function PresenceStripShowcases() {
  return (
    <PlaygroundSection
      title="Presence strip"
      description="Who on this team is working right now, on the bottom line of the home header. Clicking follows into that room or session as a viewer — watch, never take over. Nobody working draws nothing at all: the strip stands down and the header collapses around it."
    >
      <ShowcaseLabel>Working: one agent, and where it is</ShowcaseLabel>
      <ShowcaseDemo>
        <PresenceStrip rows={[REPLYING]} onFollow={() => {}} />
      </ShowcaseDemo>

      <ShowcaseLabel>Working late: the same row, admitting the wait</ShowcaseLabel>
      <ShowcaseDemo>
        <PresenceStrip rows={[LATE]} onFollow={() => {}} />
      </ShowcaseDemo>

      <ShowcaseLabel>Several at once, room claims first</ShowcaseLabel>
      <ShowcaseDemo>
        <PresenceStrip rows={[REPLYING, LATE, IN_SESSION]} onFollow={() => {}} />
      </ShowcaseDemo>

      <ShowcaseLabel>
        A busy fleet: still one line, with the remainder counted rather than wrapped
      </ShowcaseLabel>
      <ShowcaseDemo>
        <PresenceStrip rows={BUSY_FLEET} onFollow={() => {}} />
      </ShowcaseDemo>

      <ShowcaseLabel>
        The same twelve at phone width — the header must not grow to fit them
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border/60 w-[375px] max-w-full rounded-lg border border-dashed p-2">
          <PresenceStrip rows={BUSY_FLEET} onFollow={() => {}} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>No binding: the name, and nothing invented to sit after it</ShowcaseLabel>
      <ShowcaseDemo>
        <PresenceStrip rows={[NO_BINDING]} onFollow={() => {}} />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Quiet: zero DOM, not an empty box (the frame below is the demo&rsquo;s)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border/60 w-full rounded-lg border border-dashed p-4">
          <PresenceStrip rows={[]} onFollow={() => {}} />
          <p className="text-muted-foreground text-xs">The header collapses to here.</p>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
