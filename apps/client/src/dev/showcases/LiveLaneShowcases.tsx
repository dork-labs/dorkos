/**
 * Every state the live lane can be in, in one place.
 *
 * Ten states share one line, and which one wins is a priority stack — so a
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
  type LivePeekRow,
} from '@/layers/features/conversation';
import type { ConversationCapabilities } from '@/layers/features/conversation';
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
  toolCards: false,
  mentions: true,
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
  presence: false,
  turnStatus: true,
};

/** Ages a claim so its elapsed reading is a real one. */
function claim(
  name: string,
  secondsIn: number,
  state: LanePresenceAuthor['state'] = 'working'
): LanePresenceAuthor {
  return {
    authorId: name.toLowerCase().replace(/\s+/gu, '-'),
    name,
    state,
    since: new Date(Date.now() - secondsIn * 1_000).toISOString(),
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
    queueDepth: 0,
  });
}

/** A session's turn, streaming unless told otherwise. */
function turn(overrides: Partial<LaneTurn> = {}): LaneState {
  return deriveLaneState({
    capabilities: SESSION_LIKE,
    asks: NO_ASKS,
    stalled: false,
    presence: [],
    queueDepth: 0,
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

/** The Ask rung's fixture. P3 replaces this placeholder with the real event. */
const PENDING_ASK: LaneAsk = {
  sessionId: 'session-1',
  interactionId: 'interaction-1',
  headline: 'Meeting Notes needs your OK to run pnpm verify',
};

/** The lane's composer footprint, so each state is seen where it lives. */
function LaneBox({ children }: { children: React.ReactNode }) {
  return <div className="bg-card w-full max-w-lg rounded-lg border py-2">{children}</div>;
}

/** Every rung of the priority stack, in the order it is checked. */
export function LiveLaneShowcase() {
  return (
    <PlaygroundSection
      title="Live lane"
      description="One reserved line above the composer, on every conversation surface. It is a fixed 24 pixels whether or not it has anything to say — that is the whole feature, because it means an agent picking something up cannot push the message you were reading. Ten states share it and the first match wins: an Ask outranks a stalled stream (a prompt in hand is still answerable when the wire goes quiet), a stalled stream outranks presence (a client that cannot read the stream must not claim to know who is working), and everything about this conversation's own turn sits below both. Only the working dot moves."
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
        An Ask — amber, and never amber alone: the word Answer carries the same fact. The card it
        grows into lands in P3.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={{ kind: 'ask', ask: PENDING_ASK, count: 1 }} />
        </LaneBox>
      </ShowcaseDemo>

      <ShowcaseLabel>An Ask, with more behind it</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={{ kind: 'ask', ask: PENDING_ASK, count: 3 }} />
        </LaneBox>
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

      <ShowcaseLabel>Drafts the composer is holding until this turn ends</ShowcaseLabel>
      <ShowcaseDemo>
        <LaneBox>
          <Conversation.LiveLane state={{ kind: 'queued', depth: 1 }} />
        </LaneBox>
        <LaneBox>
          <Conversation.LiveLane state={{ kind: 'queued', depth: 4 }} />
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
    // Out of the loaded page, so there is nothing honest to quote.
    replyingTo: null,
    sessionId: 'session-kai',
  },
];

/** The peek, in the two shapes its Stop takes. */
export function LivePeekShowcase() {
  return (
    <PlaygroundSection
      title="Live peek"
      description="What the lane opens into: one row per working agent, with its face, how long it has been going, what it is answering, and a way into its session. Stop is the room-wide halt and the label never claims otherwise. With exactly one agent working, stopping the room and stopping the agent are the same act, so the row offers Stop. With two or more there is no per-row Stop at all — one footer action that says how many it takes down. The drawn box is the popover's; on a phone the same content is a bottom sheet."
    >
      <ShowcaseLabel>
        One agent — Stop on its row, because it is the only thing running
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-popover w-88 rounded-lg border shadow-md">
          <Conversation.LivePeek
            rows={ONE_ROW}
            onScrollToRow={() => {}}
            onOpenSession={() => {}}
            onStopAll={() => {}}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Three agents — no per-row Stop, and a footer that counts what it will take down
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-popover w-88 rounded-lg border shadow-md">
          <Conversation.LivePeek
            rows={THREE_ROWS}
            onScrollToRow={() => {}}
            onOpenSession={() => {}}
            onStopAll={() => {}}
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
