/**
 * The thread side panel and its "N replies" row — DOR-761.
 *
 * Two components, benched separately because they are seen at different
 * moments: the reply row lives in the room's own scroll and is read-or-unread
 * before it is ever pressed; the panel is a mode, entered by pressing it.
 * `ThreadPanelDemo` (in `room-thread-showcase-helpers`) wires the real
 * component to a `Transport` fixture the same way `RoomSheetDemo` does for the
 * room sheet, so the composer here really posts and the reply that comes back
 * really lands in the thread.
 *
 * @module dev/showcases/RoomThreadShowcases
 */
import { useState } from 'react';
import { Button } from '@/layers/shared/ui';
import type { RoomEntry } from '@/layers/entities/room';
import { useRoomPresenceStore } from '@/layers/entities/room';
import { ConversationRoot, ThreadReplyRow } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '@/layers/widgets/room-view';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ThreadPanelDemo } from './room-thread-showcase-helpers';
import {
  THREAD_AGENT_ANA,
  THREAD_AGENT_KAI,
  THREAD_ROOM_ID,
  threadEntry,
  threadReply,
} from './room-thread-showcase-data';

// ---------------------------------------------------------------------------
// ThreadReplyRow
// ---------------------------------------------------------------------------

const ROOT_FOR_ROW = threadEntry('the deploy is stuck — the last step never returned');

/** Three ordinary replies, read seconds apart. */
function threeReplies(): RoomEntry[] {
  return [
    threadReply(ROOT_FOR_ROW, 'looking at it now', { authorId: THREAD_AGENT_ANA.id }),
    threadReply(ROOT_FOR_ROW, 'the last step never returned — checking the runner logs', {
      authorId: THREAD_AGENT_ANA.id,
    }),
    threadReply(ROOT_FOR_ROW, 'found it: the cache was cold', {
      authorId: THREAD_AGENT_KAI.id,
      createdAt: '2026-07-30T09:45:00.000Z',
    }),
  ];
}

/** One row with its own open/closed toggle, so `aria-expanded` is really live. */
function ReplyRowDemo({
  replies,
  lastReadSeq,
  startOpen = false,
}: {
  replies: RoomEntry[];
  lastReadSeq: number | null;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    // The row reads its conversation for `capabilities.threads`, so the bench
    // brings the same Root the room mounts rather than a stand-in.
    <ConversationRoot surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
      <ThreadReplyRow
        replies={replies}
        lastReadSeq={lastReadSeq}
        open={open}
        onOpen={() => setOpen((prev) => !prev)}
      />
    </ConversationRoot>
  );
}

/** A row that grows by one reply per press, so the count-flip animation is reachable on demand. */
function GrowingReplyRowDemo() {
  const [replies, setReplies] = useState<RoomEntry[]>(() => threeReplies());
  return (
    <div className="flex flex-col items-start gap-2">
      <ConversationRoot surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
        <ThreadReplyRow
          replies={replies}
          lastReadSeq={null}
          open={false}
          onOpen={() => setReplies((prev) => [...prev, threadReply(ROOT_FOR_ROW, 'and again')])}
        />
      </ConversationRoot>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setReplies((prev) => [...prev, threadReply(ROOT_FOR_ROW, 'one more')])}
      >
        Add a reply
      </Button>
    </div>
  );
}

/** Forty replies, none of which get their own line — that is the row's whole point. */
function longThread(): RoomEntry[] {
  return Array.from({ length: 40 }, (_, i) => threadReply(ROOT_FOR_ROW, `reply ${i + 1}`));
}

interface ReplyRowState {
  label: string;
  replies: RoomEntry[];
  lastReadSeq: number | null;
  startOpen?: boolean;
}

/** Every static state the row has, read top to bottom in the order the description walks them. */
function replyRowStates(): ReplyRowState[] {
  const replies = threeReplies();
  return [
    { label: 'Read — muted, no accent', replies, lastReadSeq: replies.at(-1)!.seq },
    {
      label: 'Unread — accent, and the count named out loud',
      replies,
      lastReadSeq: replies[0]!.seq - 1,
    },
    {
      label: 'Open — press it, or read `aria-expanded` on the button itself',
      replies,
      lastReadSeq: replies.at(-1)!.seq,
      startOpen: true,
    },
    {
      label: 'Singular — "1 reply", not "1 replies"',
      replies: [threadReply(ROOT_FOR_ROW, 'on it')],
      lastReadSeq: null,
    },
    { label: 'Forty replies — still one row', replies: longThread(), lastReadSeq: null },
  ];
}

function ThreadReplyRowShowcase() {
  return (
    <PlaygroundSection
      title="ThreadReplyRow"
      description="The quiet line under a thread root — “↳ 3 replies · last 9:45 AM”. It replaces the old inline reply gathering (design record §3): a room shows a room, and a thread has its own place to be, however long it runs. Unread is derived from the reader's frozen cursor, never stored, and colours the whole row rather than a badge — a reader scanning history is looking for colour, not a number to find first."
    >
      {replyRowStates().map((state) => (
        <div key={state.label}>
          <ShowcaseLabel>{state.label}</ShowcaseLabel>
          <ShowcaseDemo>
            <ReplyRowDemo
              replies={state.replies}
              lastReadSeq={state.lastReadSeq}
              startOpen={state.startOpen}
            />
          </ShowcaseDemo>
        </div>
      ))}

      <ShowcaseLabel>The count flip — press &quot;Add a reply&quot; to watch it snap</ShowcaseLabel>
      <p className="text-muted-foreground mb-2 text-xs">
        The number is the only thing animated (design record §5.5): a scale snap on the whole
        sentence would shift the row&apos;s width and nudge its neighbours. The row is drawn at rest
        on mount — only a genuine increment moves it.
      </p>
      <ShowcaseDemo>
        <GrowingReplyRowDemo />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// RoomThreadPanel
// ---------------------------------------------------------------------------

const PANEL_ROOT = threadEntry('the deploy is stuck — the last step never returned');
const PANEL_REPLIES = [
  threadReply(PANEL_ROOT, 'looking at it now', { authorId: THREAD_AGENT_ANA.id }),
  threadReply(PANEL_ROOT, 'the cache was cold — rerunning it clean', {
    authorId: THREAD_AGENT_ANA.id,
  }),
];

const ORPHAN_ROOT = threadEntry('(never loaded — this entry is not in `entries`)');
const ORPHAN_REPLIES = [
  threadReply(ORPHAN_ROOT, 'still worth reading, even without its root', {
    authorId: THREAD_AGENT_KAI.id,
  }),
];

const EMPTY_ROOT = threadEntry('nobody has replied to this yet');

function RoomThreadPanelShowcase() {
  return (
    <PlaygroundSection
      title="RoomThreadPanel"
      description="One thread, with its own composer, beside the room (design record §3). Root at the top with its own reactions, replies beneath it on a connector. Each demo below wires the real panel to an in-memory fixture — reads and writes both — so replying through the composer really lands the reply in the thread. Presence and reactions come from live app state (the Zustand store and query cache), so leaving this page resets them."
    >
      <ShowcaseLabel>Normal — root and two replies</ShowcaseLabel>
      <ShowcaseDemo>
        <ThreadPanelDemo rootEntryId={PANEL_ROOT.id} entries={[PANEL_ROOT, ...PANEL_REPLIES]} />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Orphaned — the root is missing, its replies are not (design record §4)
      </ShowcaseLabel>
      <ShowcaseDemo>
        {/* `rootEntryId` names `ORPHAN_ROOT`, but `entries` never carries it —
            only its replies — which is exactly the shape a page of history
            that starts after the root produces. */}
        <ThreadPanelDemo rootEntryId={ORPHAN_ROOT.id} entries={ORPHAN_REPLIES} />
      </ShowcaseDemo>

      <ShowcaseLabel>Empty — a root and a composer, and deliberately nothing else</ShowcaseLabel>
      <ShowcaseDemo>
        <ThreadPanelDemo rootEntryId={EMPTY_ROOT.id} entries={[EMPTY_ROOT]} />
      </ShowcaseDemo>

      <ShowcaseLabel>Stream stalled — reactions and the composer refuse the write</ShowcaseLabel>
      <ShowcaseDemo>
        <ThreadPanelDemo
          rootEntryId={PANEL_ROOT.id}
          entries={[PANEL_ROOT, ...PANEL_REPLIES]}
          streamStalled
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Pushed — the mobile full-screen framing, Back instead of Close</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ThreadPanelDemo
          rootEntryId={PANEL_ROOT.id}
          entries={[PANEL_ROOT, ...PANEL_REPLIES]}
          pushed
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Opened to reply — the composer takes the caret on mount</ShowcaseLabel>
      <ShowcaseDemo>
        <ThreadPanelDemo
          rootEntryId={PANEL_ROOT.id}
          entries={[PANEL_ROOT, ...PANEL_REPLIES]}
          focusComposer
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// Micro-interactions: the connector draw, the reply drop, the presence hand-off
// ---------------------------------------------------------------------------

const ARRIVAL_ROOT = threadEntry('anyone know why the runner is stuck?');
const ARRIVAL_REPLIES = [
  threadReply(ARRIVAL_ROOT, 'checking now', { authorId: THREAD_AGENT_ANA.id }),
];

/**
 * A panel whose replies arrive live, so the three thread animations (design
 * record §5.3–5.5) can be watched on demand rather than raced against a real
 * SSE event. `useThreadArrivals` (the hook both animations key off) decides
 * "dropped" vs "handed-off" from whether the replying author was on the
 * presence line a moment before their reply landed — so the buttons below
 * drive that same signal directly: one appends a reply cold, the two-step
 * sequence puts its author on the presence line first and only then lands it.
 */
function ArrivalDemo() {
  const [key, setKey] = useState(0);
  const [injected, setInjected] = useState<RoomEntry[]>([]);

  const dropIn = () => {
    setInjected((prev) => [
      ...prev,
      threadReply(ARRIVAL_ROOT, 'same thing happened last Tuesday', {
        authorId: THREAD_AGENT_ANA.id,
      }),
    ]);
  };

  const kaiStartsWorking = () => {
    useRoomPresenceStore.getState().observe(THREAD_ROOM_ID, {
      type: 'signal',
      signal: 'progress',
      authorId: THREAD_AGENT_KAI.id,
      at: new Date().toISOString(),
      state: 'working',
      // A REPLY's id, never the root's. `PresenceScope` scopes a thread's
      // presence to its replies on purpose — the root is also an ordinary
      // message in the room's flow, so a claim on it belongs to the room's
      // line, not this panel's. Keyed on the root, this bench put nothing on
      // the panel's presence line and the hand-off it exists to demonstrate
      // silently became an ordinary drop.
      entryId: ARRIVAL_REPLIES[0]!.id,
      since: new Date().toISOString(),
    });
  };

  const landKaisReply = () => {
    setInjected((prev) => [
      ...prev,
      threadReply(ARRIVAL_ROOT, 'found it — the runner image was stale', {
        authorId: THREAD_AGENT_KAI.id,
      }),
    ]);
    useRoomPresenceStore.getState().clearAuthor(THREAD_ROOM_ID, THREAD_AGENT_KAI.id);
  };

  const reset = () => {
    useRoomPresenceStore.getState().clearRoom(THREAD_ROOM_ID);
    setInjected([]);
    setKey((prev) => prev + 1);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={dropIn}>
          Ordinary reply drops in
        </Button>
        <Button variant="outline" size="sm" onClick={kaiStartsWorking}>
          1. Kai starts working
        </Button>
        <Button variant="outline" size="sm" onClick={landKaisReply}>
          2. Land Kai&apos;s reply — hands off
        </Button>
        <Button variant="ghost" size="sm" onClick={reset}>
          Reset
        </Button>
      </div>
      <ThreadPanelDemo
        key={key}
        rootEntryId={ARRIVAL_ROOT.id}
        entries={[ARRIVAL_ROOT, ...ARRIVAL_REPLIES]}
        injected={injected}
      />
    </div>
  );
}

function ThreadArrivalShowcase() {
  return (
    <PlaygroundSection
      title="Thread arrival animations"
      description="Three one-shot motions live in this panel (design record §5.3–5.5), all keyed by `useThreadArrivals` so they play once per reply and never replay on an unrelated re-render: the connector drawing downward, an ordinary reply bouncing in, and an agent's reply settling upward out of the presence line it just occupied. `ThreadReplyRow`'s own count-flip is benched separately above, on the row itself."
    >
      <ShowcaseLabel>
        &quot;Ordinary reply&quot; plays the connector draw and the drop-in. The two-step Kai
        sequence plays the hand-off: watch the presence line above the composer clear as the reply
        settles into the space it leaves.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ArrivalDemo />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Every thread component, every state the design record calls out. */
export function RoomThreadShowcases() {
  return (
    <>
      <ThreadReplyRowShowcase />
      <RoomThreadPanelShowcase />
      <ThreadArrivalShowcase />
    </>
  );
}
