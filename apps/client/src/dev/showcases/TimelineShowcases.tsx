/**
 * Timeline — the one virtualized list every surface draws, in every state it
 * has.
 *
 * Loading, empty, grouped history with its dividers, a thread's reply line,
 * the pending list, and a long virtualized run — the states `Conversation.Timeline`
 * (`features/conversation/ui/Timeline.tsx`) actually has, drawn through the
 * REAL component rather than a description of it. There was no Timeline
 * showcase before this (DOR-1332, P5): the compound shipped in P4 with no
 * bench of its own.
 *
 * @module dev/showcases/TimelineShowcases
 */
import {
  Conversation,
  DayDivider,
  UnreadDivider,
  ThreadReplyRow,
  type ConversationRow,
} from '@/layers/features/conversation';
import { ChatEmptyState, TypingDots } from '@/layers/features/chat';
import { Feed } from '@/layers/shared/ui';
import { SESSION_CAPABILITIES, SessionMessage } from '@/layers/widgets/session';
import { ROOM_CAPABILITIES, RoomMessage } from '@/layers/widgets/room-view';
import type { PendingPost } from '@/layers/entities/room';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createUserMessage, createAssistantMessage, MOCK_SESSION_ID } from '../mock-chat-data';
import {
  BENCH_AGENT,
  BENCH_AGENT_REF,
  BENCH_AUTHORS,
  BENCH_FREQUENTS,
  BENCH_NAMES,
  BENCH_ROOM_ID,
  BENCH_VIEWER,
  BENCH_VIEWER_ID,
  BENCH_VIEWER_REF,
  benchEntry,
} from './entry-actions-showcase-data';

/**
 * Frozen at module load, not read per render: `Date.now()` during render is
 * impure (`react-hooks/purity`), and a pending row whose "sent" moment shifts
 * on every re-render is harder to read anyway. Same shape as
 * `AsksShowcases.tsx`'s own `NOW`.
 */
const PENDING_AT = Date.now();

/** A subheading inside the one Timeline section — not its own registry entry. */
function Subhead({ children }: { children: string }) {
  return <h3 className="text-foreground mt-2 text-sm font-semibold">{children}</h3>;
}

/** A bounded box, the shape the timeline sits inside on every real surface. */
function TimelineFrame({ children, height = 320 }: { children: React.ReactNode; height?: number }) {
  return (
    <div
      className="border-border bg-background flex flex-col overflow-hidden rounded-lg border"
      style={{ height }}
    >
      {children}
    </div>
  );
}

/** Loading: the same feed the loaded conversation renders, saying it is busy. */
function LoadingDemo() {
  return (
    <>
      <ShowcaseLabel>Loading — the first page of history has not arrived yet</ShowcaseLabel>
      <ShowcaseDemo>
        <TimelineFrame height={160}>
          <Feed
            label="Loading demo"
            busy
            className="flex h-full items-center justify-center"
            data-testid="timeline-loading-demo"
          >
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <TypingDots />
              Loading conversation...
            </div>
          </Feed>
        </TimelineFrame>
      </ShowcaseDemo>
    </>
  );
}

/** Empty: nothing said yet, drawn by the same ChatEmptyState a session renders. */
function EmptyDemo() {
  return (
    <>
      <ShowcaseLabel>Empty — nothing said in this conversation yet</ShowcaseLabel>
      <ShowcaseDemo>
        <TimelineFrame height={200}>
          <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
            <Conversation.Timeline
              conversationId="bench-empty"
              label="Empty demo"
              rows={[]}
              renderRow={() => null}
              empty={
                <div className="flex h-full items-center justify-center">
                  <ChatEmptyState birthRecord={null} firstLightRecord={null} />
                </div>
              }
            />
          </Conversation.Root>
        </TimelineFrame>
      </ShowcaseDemo>
    </>
  );
}

/** Grouped history, day and unread dividers, drawn through the real virtualized list. */
function GroupingAndDividersDemo() {
  const rows: ConversationRow[] = [
    { kind: 'day-divider', id: 'day-1', label: 'Monday, August 17' },
    {
      kind: 'message',
      id: 'g-1',
      payload: createUserMessage({ content: 'Morning — anything from overnight?' }),
      grouping: { position: 'only' },
      author: BENCH_VIEWER,
      at: '2026-08-17T09:00:00.000Z',
    },
    {
      kind: 'message',
      id: 'g-2',
      payload: createAssistantMessage({ content: 'Nothing broke. The nightly build is green.' }),
      grouping: { position: 'first' },
      author: { kind: 'agent', id: 'dorkbot', displayName: 'DorkBot' },
      at: '2026-08-17T09:00:05.000Z',
    },
    {
      kind: 'message',
      id: 'g-3',
      payload: createAssistantMessage({
        content: 'I did notice the deploy job ran twenty minutes long.',
      }),
      grouping: { position: 'last' },
      author: { kind: 'agent', id: 'dorkbot', displayName: 'DorkBot' },
      at: '2026-08-17T09:00:35.000Z',
    },
    { kind: 'day-divider', id: 'day-2', label: 'Today' },
    { kind: 'unread-divider', id: 'unread-1' },
    {
      kind: 'message',
      id: 'g-4',
      payload: createUserMessage({ content: 'Can you look into that twenty minutes?' }),
      grouping: { position: 'only' },
      author: BENCH_VIEWER,
      at: '2026-08-18T08:15:00.000Z',
    },
  ];

  return (
    <>
      <ShowcaseLabel>
        Grouped history with day and unread dividers — three same-author messages collapse into one
        group, the unread rule marks where the reader left off
      </ShowcaseLabel>
      <ShowcaseDemo>
        <TimelineFrame>
          <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
            <Conversation.Timeline
              conversationId="bench-grouping"
              label="Grouping demo"
              rows={rows}
              landOn="end"
              renderRow={(row) => {
                if (row.kind === 'day-divider') return <DayDivider label={row.label} />;
                if (row.kind === 'unread-divider') return <UnreadDivider />;
                if (row.kind !== 'message') return null;
                return (
                  <SessionMessage
                    message={row.payload as ReturnType<typeof createUserMessage>}
                    grouping={row.grouping}
                    author={row.author}
                    sessionId={MOCK_SESSION_ID}
                  />
                );
              }}
            />
          </Conversation.Root>
        </TimelineFrame>
      </ShowcaseDemo>
    </>
  );
}

/** The pending list: messages this reader sent that the room hasn't echoed back. */
function PendingListDemo() {
  const pending: PendingPost[] = [
    {
      clientId: 'pending-1',
      roomId: BENCH_ROOM_ID,
      threadRootId: null,
      text: 'Retried the migration — watching it now.',
      attachmentNames: [],
      attachmentIds: [],
      status: 'sending',
      entryId: null,
      at: PENDING_AT - 2_000,
    },
    {
      clientId: 'pending-2',
      roomId: BENCH_ROOM_ID,
      threadRootId: null,
      text: 'Also flagging this for the standup.',
      attachmentNames: [],
      attachmentIds: [],
      status: 'failed',
      entryId: null,
      at: PENDING_AT - 1_000,
    },
  ];
  const entry = benchEntry('Retrying the migration now.', { authorId: BENCH_AGENT.id });

  return (
    <>
      <ShowcaseLabel>
        Pending — sent, not yet echoed back. Outside the feed&apos;s own numbering: a message the
        server has not accepted is not one of its articles yet
      </ShowcaseLabel>
      <ShowcaseDemo>
        <TimelineFrame height={260}>
          <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
            <Conversation.Timeline
              conversationId="bench-pending"
              label="Pending demo"
              rows={[
                {
                  kind: 'message',
                  id: 'pending-history-1',
                  payload: entry,
                  grouping: { position: 'only' },
                  author: BENCH_AGENT,
                  at: entry.createdAt,
                },
              ]}
              pending={pending}
              viewerAuthorId={BENCH_VIEWER_ID}
              renderRow={(row) => {
                if (row.kind !== 'message') return null;
                return (
                  <RoomMessage
                    roomId={BENCH_ROOM_ID}
                    entry={row.payload as typeof entry}
                    author={BENCH_AGENT}
                    authorRef={BENCH_AGENT_REF}
                    authors={BENCH_AUTHORS}
                    viewerAuthorId={BENCH_VIEWER_ID}
                    authorNames={BENCH_NAMES}
                    reactionFrequents={BENCH_FREQUENTS}
                    grouping={row.grouping}
                  />
                );
              }}
            />
          </Conversation.Root>
        </TimelineFrame>
      </ShowcaseDemo>
    </>
  );
}

/** The quiet line under a thread's root, and the reply count that flips when it advances. */
function ThreadGroupingDemo() {
  const root = benchEntry('Anyone know why the migration is timing out?', {
    authorId: BENCH_VIEWER_ID,
  });
  const replies = [
    benchEntry('Looks like a row lock on the users table.', {
      authorId: BENCH_AGENT.id,
      parentEntryId: root.id,
      threadRootEntryId: root.id,
    }),
    benchEntry('Retrying with a shorter lock timeout.', {
      authorId: BENCH_AGENT.id,
      parentEntryId: root.id,
      threadRootEntryId: root.id,
    }),
    benchEntry('That did it — deploy is unstuck.', {
      authorId: BENCH_AGENT.id,
      parentEntryId: root.id,
      threadRootEntryId: root.id,
    }),
  ];

  return (
    <>
      <ShowcaseLabel>
        Thread grouping — the root, then the quiet reply line beneath it (&ldquo;&#8627; 3 replies ·
        last &hellip;&rdquo;)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
          <RoomMessage
            roomId={BENCH_ROOM_ID}
            entry={root}
            author={BENCH_VIEWER}
            authorRef={BENCH_VIEWER_REF}
            authors={BENCH_AUTHORS}
            viewerAuthorId={BENCH_VIEWER_ID}
            authorNames={BENCH_NAMES}
            reactionFrequents={BENCH_FREQUENTS}
            grouping={{ position: 'only' }}
          />
          <ThreadReplyRow
            replies={replies}
            lastReadSeq={replies[0]!.seq - 1}
            open={false}
            onOpen={() => {}}
          />
        </Conversation.Root>
      </ShowcaseDemo>
    </>
  );
}

/** Long enough that virtualization is visibly doing something. */
function VirtualizedRunDemo() {
  const rows: ConversationRow[] = Array.from({ length: 400 }, (_, index) => {
    const fromHuman = index % 4 === 0;
    const message = fromHuman
      ? createUserMessage({ content: `Checking in on step ${index}.` })
      : createAssistantMessage({ content: `Step ${index} finished without errors.` });
    return {
      kind: 'message',
      id: `virtualized-${index}`,
      payload: message,
      grouping: { position: 'only' },
      author: fromHuman ? BENCH_VIEWER : { kind: 'agent', id: 'dorkbot', displayName: 'DorkBot' },
      at: new Date(Date.parse('2026-08-01T00:00:00.000Z') + index * 60_000).toISOString(),
    };
  });

  return (
    <>
      <ShowcaseLabel>
        A long run — 400 rows. Only the rows near the viewport are ever in the DOM; scroll to feel
        it
      </ShowcaseLabel>
      <ShowcaseDemo>
        <TimelineFrame height={320}>
          <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
            <Conversation.Timeline
              conversationId="bench-virtualized"
              label="Long run demo"
              rows={rows}
              landOn="end"
              renderRow={(row) => {
                if (row.kind !== 'message') return null;
                return (
                  <SessionMessage
                    message={row.payload as ReturnType<typeof createUserMessage>}
                    grouping={row.grouping}
                    author={row.author}
                    sessionId={MOCK_SESSION_ID}
                  />
                );
              }}
            />
          </Conversation.Root>
        </TimelineFrame>
      </ShowcaseDemo>
    </>
  );
}

/**
 * The one virtualized list, in every state it has: loading, empty, grouped
 * history with its dividers, a thread's reply line, the pending list, and a
 * long virtualized run.
 */
export function TimelineShowcase() {
  return (
    <PlaygroundSection
      title="Timeline"
      description="Conversation.Timeline — the one virtualized list a session's transcript and a room's history both draw through the real Feed and the real SessionMessage / RoomMessage row renderers. `renderRow` is the seam: a session draws SessionMessage, a channel draws RoomMessage, and this component reads neither — it only knows six row kinds."
    >
      <LoadingDemo />
      <Subhead>Empty</Subhead>
      <EmptyDemo />
      <Subhead>Grouping and dividers</Subhead>
      <GroupingAndDividersDemo />
      <Subhead>Thread grouping</Subhead>
      <ThreadGroupingDemo />
      <Subhead>Pending list</Subhead>
      <PendingListDemo />
      <Subhead>A long virtualized run</Subhead>
      <VirtualizedRunDemo />
    </PlaygroundSection>
  );
}
