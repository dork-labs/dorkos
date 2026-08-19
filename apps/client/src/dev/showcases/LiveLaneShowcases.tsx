/**
 * Every state the live lane can be in, in one place.
 *
 * Nine states share one line, and which one wins is a priority stack — so a
 * regression in the stack is exactly the kind of thing that hides until
 * somebody happens to hit the fourth-most-likely case. Drawn all at once, it is
 * one glance.
 *
 * **These are the REAL components**, driven by a `LaneState` the same pure
 * function the product uses builds from a fixture. A recreation of the markup
 * here would hide the regression this section exists to catch.
 *
 * @module dev/showcases/LiveLaneShowcases
 */
import {
  Conversation,
  deriveLaneState,
  NO_ASKS,
  type LaneAsk,
  type LanePresenceAuthor,
  type LaneState,
  type LaneTurn,
  type LaneHeldAuthor,
  type LivePeekRow,
} from '@/layers/features/conversation';
import type { ConversationCapabilities } from '@/layers/features/conversation';
import { AskCard, AskReceiptLine, InteractionAsk } from '@/layers/features/ask';
import type { AskReceipt } from '@/layers/entities/attention';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { AGENT_AUTHOR, HUMAN_AUTHOR } from '../mock-samples';

/**
 * A room's table, and a session's.
 *
 * Declared here rather than imported for the reason `lane-state.test.ts`
 * declares its own: `ROOM_CAPABILITIES` lives in a widget's model, and the dev
 * playground reaching into one for two booleans would tie every showcase to a
 * host it does not render.
 */
const ROOM_LIKE: ConversationCapabilities = {
  reactions: true,
  threads: true,
  runWith: false,
  attachments: true,
  mentions: true,
  streamHealth: true,
  presence: true,
  turnStatus: false,
  asks: true,
};

/** The session's: a turn of its own, and nobody else's presence. */
const SESSION_LIKE: ConversationCapabilities = {
  ...ROOM_LIKE,
  reactions: false,
  threads: false,
  mentions: false,
  streamHealth: false,
  presence: false,
  turnStatus: true,
};

/** Ages a claim so its elapsed reading is a real one. */
function claim(
  name: string,
  secondsIn: number,
  state: LanePresenceAuthor['state'] = 'working',
  activity: LanePresenceAuthor['activity'] = null
): LanePresenceAuthor {
  return {
    authorId: name.toLowerCase().replace(/\s+/gu, '-'),
    name,
    state,
    since: new Date(Date.now() - secondsIn * 1_000).toISOString(),
    activity,
  };
}

/** The presence rung for a set of claims. */
function presence(claims: readonly LanePresenceAuthor[]): LaneState {
  return deriveLaneState({
    capabilities: ROOM_LIKE,
    asks: NO_ASKS,
    stalled: false,
    presence: claims,
    turn: null,
  });
}

/**
 * One agent whose answer to this room has not started, `secondsIn` seconds ago.
 *
 * @param name - What to call it.
 * @param secondsIn - How long the message has been waiting.
 * @param behindTitle - What to call the conversation in the way, or `null` when
 *   this reader cannot see it.
 */
function held(name: string, secondsIn: number, behindTitle: string | null): LaneHeldAuthor {
  return {
    authorId: name.toLowerCase().replace(/\s+/gu, '-'),
    name,
    since: new Date(Date.now() - secondsIn * 1_000).toISOString(),
    behind: { roomId: 'room-elsewhere', title: behindTitle },
    othersWaiting: false,
  };
}

/** The waiting rung for a set of holds. */
function waiting(holds: readonly LaneHeldAuthor[]): LaneState {
  return deriveLaneState({
    capabilities: ROOM_LIKE,
    asks: NO_ASKS,
    stalled: false,
    presence: [],
    held: holds,
    turn: null,
  });
}

/** A session's turn, streaming unless told otherwise. */
function turn(overrides: Partial<LaneTurn> = {}): LaneState {
  return deriveLaneState({
    capabilities: SESSION_LIKE,
    asks: NO_ASKS,
    stalled: false,
    presence: [],
    turn: {
      status: 'streaming',
      isWaitingForUser: false,
      waitingType: 'approval',
      operationProgress: null,
      systemStatus: null,
      elapsed: '1m 04s',
      activity: { toolName: 'Bash', target: 'pnpm verify' },
      tokens: '~3.2k tokens',
      isBypass: false,
      showComplete: false,
      lastElapsed: '2m 10s',
      lastTokens: '~8.0k tokens',
      ...overrides,
    },
  });
}

/**
 * The Ask rung's fixture clock — read once, at module load, never per render
 * (`Date.now()` during render is impure, `react-hooks/purity`).
 *
 * A wall-clock reading rather than a written-out date, for the reason
 * `AsksShowcases` spells out at its own `NOW`: the card's deadline is
 * `startedAt + timeoutMs`, so a date pinned in the source is a deadline in the
 * past and the grown card reads "expired" instead of counting.
 */
const NOW_ASK = Date.now();

const PENDING_ASK: LaneAsk = {
  sessionId: 'session-1',
  cwd: '/projects/meeting-notes',
  interaction: {
    type: 'approval',
    id: 'interaction-1',
    startedAt: NOW_ASK - 60_000,
    remainingMs: 540_000,
    timeoutMs: 600_000,
    toolName: 'Bash',
    input: JSON.stringify({ command: 'pnpm verify' }),
    hasSuggestions: false,
  },
};

/** The line the lane draws for it. */
const ASK_HEADLINE = 'Meeting Notes wants to run "pnpm verify"';

/**
 * The three endings the lane's own card can settle into.
 *
 * The real `AskReceiptLine` inside a real resolved `AskCard.Root` — the exact
 * pair `InteractionAsk` renders once `useAskReceipt` answers, so this bench
 * cannot drift from the card the lane actually opens. (The transcript's
 * one-line `AskReceipt` is a different component for a different place, and is
 * benched on the Asks section beside the prompts it records.)
 */
const LANE_RECEIPTS: readonly [string, AskReceipt][] = [
  [
    'Answered here',
    {
      outcome: 'answered',
      resolvedAt: new Date(NOW_ASK).toISOString(),
      byThisWindow: true,
      decision: 'allowed',
    },
  ],
  [
    'Answered in another window',
    { outcome: 'answered', resolvedAt: new Date(NOW_ASK).toISOString(), byThisWindow: false },
  ],
  [
    'Answered by the clock',
    { outcome: 'expired', resolvedAt: new Date(NOW_ASK).toISOString(), byThisWindow: false },
  ],
];

/** The lane's composer footprint, so each state is seen where it lives. */
function LaneBox({ children }: { children: React.ReactNode }) {
  return <div className="bg-card w-full max-w-lg rounded-lg border py-2">{children}</div>;
}

/** Every rung of the priority stack, in the order it is checked. */
export function LiveLaneShowcase() {
  return (
    <PlaygroundSection
      title="Live lane"
      description="One reserved line above the composer, on every conversation surface. It is a fixed 24 pixels whether or not it has anything to say — that is the whole feature, because it means an agent picking something up cannot push the message you were reading. Nine states share it and the first match wins: an Ask outranks a stalled stream (a prompt in hand is still answerable when the wire goes quiet), a stalled stream outranks presence (a client that cannot read the stream must not claim to know who is working), and everything about this conversation's own turn sits below both. Only the working dot moves."
    >
      <ShowcaseLabel>
        Empty — a quiet room looks quiet. The bordered box below is the showcase&apos;s, not the
        lane&apos;s: the shipped lane has no border and no placeholder, and the 24 pixels inside the
        box are all it draws.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={{ kind: 'empty' }} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>Presence — one agent, and how long the room has been waiting</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={presence([claim('Meeting Notes', 64)])} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>Presence — one agent, and what it is doing right now</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane
            state={presence([
              claim('Meeting Notes', 64, 'working', { toolName: 'Read', target: 'standup.md' }),
            ])}
          />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>Presence — two, counted from the one that started first</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane
            state={presence([claim('Meeting Notes', 180), claim('Release Bot', 30)])}
          />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>Presence — three, which is the most a line this size will name</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane
            state={presence([
              claim('Meeting Notes', 240),
              claim('Release Bot', 120),
              claim('Kai', 60),
            ])}
          />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>Presence — four, counted; the names move into the peek</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane
            state={presence([
              claim('Meeting Notes', 360),
              claim('Release Bot', 300),
              claim('Kai', 180),
              claim('Ana', 60),
            ])}
          />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Presence — the wait has gone long. Said at any count, because two agents twelve minutes in
        is more worth saying than one, not less.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={presence([claim('Meeting Notes', 720, 'working_late')])} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Presence — under ten seconds, so no number yet. A timer that starts at 0s draws the eye for
        nothing.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={presence([claim('Meeting Notes', 3)])} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Presence in a thread — the same rung, announced under its own name so the room&apos;s lane
        and the panel&apos;s can be told apart
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane scope="thread" state={presence([claim('Kai', 45)])} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Waiting — the agent is mid-turn in a conversation this reader can see, so the line names it.
        The dot does not pulse: nothing is running here yet.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={waiting([held('Mio Clicker PM', 40, '#mio-engagement')])} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Waiting — the conversation in the way is one this reader is not in, so the line says that
        much and no more. The wire only ever carried a room id.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={waiting([held('Mio Clicker PM', 40, null)])} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Waiting — two agents, so there is more than one conversation in the way and naming one would
        be picking a favourite
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane
            state={waiting([held('Mio Clicker PM', 400, '#mio-engagement'), held('Ana', 60, null)])}
          />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Stalled — the stream has given up. Presence is cleared rather than frozen: a client that
        cannot read the stream does not know who is working.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={{ kind: 'stalled' }} onRetry={() => {}} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>Stalled — the room itself is gone, which is a different promise</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={{ kind: 'stalled' }} unavailable onRetry={() => {}} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        An Ask — amber, and never amber alone: the word Answer carries the same fact. Pressing it
        opens the card over the composer — a popover on a desktop, a bottom sheet on a phone — so
        the lane itself stays the one reserved line it always is.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane
            state={{ kind: 'ask', ask: PENDING_ASK, count: 1, headline: ASK_HEADLINE }}
            // The card the lane grows into, which the host supplies in the app.
            // Without it, pressing Answer opened an empty panel here.
            askCard={<InteractionAsk ask={PENDING_ASK} agentName="Meeting Notes" />}
          />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>An Ask, with more behind it</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane
            state={{ kind: 'ask', ask: PENDING_ASK, count: 3, headline: ASK_HEADLINE }}
            askCard={<InteractionAsk ask={PENDING_ASK} agentName="Meeting Notes" />}
          />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        The receipts — what the card the lane opened settles into once the prompt has ended. The
        answer can arrive from here, from another window, or from the clock, and every one of the
        three says so before the card leaves. A card that simply vanished would leave a reader
        wondering whether they answered it.
      </ShowcaseLabel>
      <ShowcaseDemo>
        {LANE_RECEIPTS.map(([label, receipt]) => (
          <LaneBox key={label}>
            <div className="px-2">
              <p className="text-muted-foreground mb-1 text-xs">{label}</p>
              <AskCard.Root isResolved>
                <AskCard.Headline className="mb-2">{ASK_HEADLINE}</AskCard.Headline>
                <AskReceiptLine receipt={receipt} />
              </AskCard.Root>
            </div>
          </LaneBox>
        ))}
      </ShowcaseDemo>

      <ShowcaseLabel>A turn parked on you, with no prompt object in hand</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={turn({ isWaitingForUser: true })} />
        </LaneBox>
        <LaneBox>
          <Conversation.LiveLane
            state={turn({ isWaitingForUser: true, waitingType: 'question' })}
          />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>A long operation — indeterminate, then with a fraction</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane
            state={turn({
              operationProgress: {
                message: 'Compacting context…',
                determinate: false,
                percent: null,
              },
            })}
          />
        </LaneBox>
        <LaneBox>
          <Conversation.LiveLane
            state={turn({
              operationProgress: {
                message: 'Compacting context…',
                determinate: true,
                percent: 65,
              },
            })}
          />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>A runtime event — a hook that just ran</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane
            state={turn({ systemStatus: { message: 'Running hook "format"…' } })}
          />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        A turn in flight — the tool it is actually running, its clock and what it has spent
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={turn()} />
        </LaneBox>
        <LaneBox>
          <Conversation.LiveLane state={turn({ activity: null })} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        A turn in flight with its permission stops off — a standing warning about the session, not a
        state of the turn
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={turn({ isBypass: true })} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>The finished turn&apos;s summary, on its way out</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={turn({ status: 'idle', showComplete: true })} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Reduced motion — the dot stays and only its breathing goes. The branch is OFF, not shorter:
        every end state above reads statically, so a reader who asked for less motion loses nothing
        but the movement. In the app it follows the reader&apos;s own system setting; these two are
        forced, which is the only way a bench can draw the branch at all.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane
            state={presence([claim('Meeting Notes', 64)])}
            reducedMotionOverride
          />
        </LaneBox>
        <LaneBox>
          <Conversation.LiveLane state={turn()} reducedMotionOverride />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>
        The same two with motion on, for comparison — the working dot breathes and nothing else in
        the lane moves
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane
            state={presence([claim('Meeting Notes', 64)])}
            reducedMotionOverride={false}
          />
        </LaneBox>
        <LaneBox>
          <Conversation.LiveLane state={turn()} reducedMotionOverride={false} />
        </LaneBox>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** One agent working, with everything the peek can say about it. */
const ONE_ROW: LivePeekRow[] = [
  {
    authorId: 'meeting-notes',
    author: AGENT_AUTHOR,
    state: 'working',
    since: new Date(Date.now() - 64_000).toISOString(),
    doing: 'Reading standup.md',
    replyingTo: {
      entryId: 'entry-1',
      excerpt: 'can you log today’s decisions?',
      rowId: 'room-entry-1',
    },
    sessionId: 'session-meeting-notes',
  },
];

/** Three agents, which is where the per-row Stop goes away. */
const THREE_ROWS: LivePeekRow[] = [
  ONE_ROW[0]!,
  {
    authorId: 'release-bot',
    author: { ...AGENT_AUTHOR, id: 'release-bot', displayName: 'Release Bot', emoji: '🚢' },
    state: 'working_late',
    since: new Date(Date.now() - 740_000).toISOString(),
    // A long turn still says what it is doing here, unlike the lane.
    doing: 'Running pnpm test',
    replyingTo: {
      entryId: 'entry-2',
      excerpt: 'can somebody check the deploy',
      rowId: 'room-entry-2',
    },
    // Nothing bound: the link is ABSENT rather than disabled.
    sessionId: null,
  },
  {
    authorId: 'kai',
    author: { ...HUMAN_AUTHOR, kind: 'agent', id: 'kai', displayName: 'Kai' },
    state: 'working',
    since: new Date(Date.now() - 45_000).toISOString(),
    // No tool call heard yet, so the peek says nothing rather than guessing.
    doing: null,
    // Out of the loaded page, so there is nothing honest to quote.
    replyingTo: null,
    sessionId: 'session-kai',
  },
];

/** Who is being stopped in the third demo below, so its own button can say so. */
const STOPPING_RELEASE_BOT: ReadonlySet<string> = new Set(['release-bot']);

/**
 * One agent working and one waiting to start — the peek's two halves.
 *
 * The waiting row sits BELOW the working one, which is the order the peek reads
 * in: who is working here, then what is waiting. Both rows offer a Stop: the
 * working one ends its turn, the held one stops this conversation waiting for
 * it (`specs/room-per-agent-stop` §5.2).
 */
const MIXED_ROWS: LivePeekRow[] = [
  ONE_ROW[0]!,
  {
    authorId: 'mio-clicker-pm',
    author: { ...AGENT_AUTHOR, id: 'mio-clicker-pm', displayName: 'Mio Clicker PM', emoji: '🎯' },
    state: 'held',
    since: new Date(Date.now() - 40_000).toISOString(),
    // Nothing has started, so there is nothing it is doing.
    doing: null,
    // Nothing to quote: no answer is in progress to be replying to anything.
    replyingTo: null,
    // Nothing of THIS room's to open — the way in is the room it is working in.
    sessionId: null,
    behind: { roomId: 'room-elsewhere', title: '#mio-engagement' },
    othersWaiting: true,
  },
];

/** The peek, and the two scopes its Stop comes in. */
export function LivePeekShowcase() {
  return (
    <PlaygroundSection
      title="Live peek"
      description="What the lane opens into: one row per working agent, with its face, how long it has been going, what it is answering, and a way into its session. Two stops, and the difference is the scope rather than the verb. A row's Stop ends THAT agent's turn and leaves everybody else working; the footer's ends everything in the room and says how many that is, so it only appears when there is more than one. A surface with no per-agent stop behind it draws no row button at all rather than a dead one. The drawn box is the popover's; on a phone the same content is a bottom sheet."
    >
      <ShowcaseLabel>One agent — its own Stop, and no footer: there is nothing else</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-popover w-88 rounded-lg border shadow-md">
          <Conversation.LivePeek
            rows={ONE_ROW}
            onScrollToRow={() => {}}
            onOpenSession={() => {}}
            onStopAll={() => {}}
            onStopAgent={() => {}}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Three agents — a Stop per row, each named for its own agent, over a footer that counts what
        it would take down
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-popover w-88 rounded-lg border shadow-md">
          <Conversation.LivePeek
            rows={THREE_ROWS}
            onScrollToRow={() => {}}
            onOpenSession={() => {}}
            onStopAll={() => {}}
            onStopAgent={() => {}}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        One stop in flight — only the row it was pressed on says so. The other two are still
        working, and a person can still stop them.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-popover w-88 rounded-lg border shadow-md">
          <Conversation.LivePeek
            rows={THREE_ROWS}
            onScrollToRow={() => {}}
            onOpenSession={() => {}}
            onStopAll={() => {}}
            onStopAgent={() => {}}
            stoppingAgents={STOPPING_RELEASE_BOT}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        One working, one waiting — the wait sits below the work, offers a way into the conversation
        in the way, and can ask to be answered first. Both rows can be stopped: the working one ends
        its turn, the waiting one stops this conversation waiting for it.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-popover w-88 rounded-lg border shadow-md">
          <Conversation.LivePeek
            rows={MIXED_ROWS}
            onScrollToRow={() => {}}
            onOpenSession={() => {}}
            onOpenRoom={() => {}}
            onAnswerFirst={() => {}}
            onStopAll={() => {}}
            onStopAgent={() => {}}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        The same wait, already asked for first — the button settles into a statement rather than
        staying something you can press again
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-popover w-88 rounded-lg border shadow-md">
          <Conversation.LivePeek
            rows={MIXED_ROWS}
            onScrollToRow={() => {}}
            onOpenSession={() => {}}
            onOpenRoom={() => {}}
            onAnswerFirst={() => {}}
            promoted={new Set(['mio-clicker-pm'])}
            onStopAll={() => {}}
            onStopAgent={() => {}}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        On a session — no Stop at all. The composer already has one, and two buttons for one verb is
        one too many.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-popover w-88 rounded-lg border shadow-md">
          <Conversation.LivePeek rows={ONE_ROW} onScrollToRow={() => {}} onOpenSession={() => {}} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
