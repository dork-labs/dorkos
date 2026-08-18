/**
 * Surfaces — session, room and DM, side by side from one fixture.
 *
 * The single most valuable section on the Conversation page: the same four
 * turns of a conversation, rendered through the three capability objects a
 * real cockpit chooses between. A regression in the unification — a row that
 * only looks right in one column, a lane that only speaks one surface's
 * vocabulary — is visible in one glance rather than three separate visits.
 *
 * **These are the REAL parts.** Each column is a genuine `Conversation.Root`
 * holding a genuine `Conversation.Timeline` (drawing `SessionMessage` or the
 * real `RoomMessage`), a genuine `Conversation.LiveLane`, and a genuine
 * `Conversation.Composer` against a fixture target — never a recreation of
 * any of the four. The room and DM columns share `ROOM_CAPABILITIES`; a DM
 * is a room whose `surface` differs in name only (`room-capabilities.ts`).
 *
 * @module dev/showcases/SurfacesShowcases
 */
import {
  Conversation,
  deriveLaneState,
  NO_ASKS,
  type ConversationRow,
  type ConversationSurface,
} from '@/layers/features/conversation';
import type { ConversationCapabilities } from '@/layers/features/conversation';
import { SessionMessage } from '@/layers/features/chat/ui/message/SessionMessage';
import { SESSION_CAPABILITIES } from '@/layers/widgets/session';
import { ROOM_CAPABILITIES, RoomMessage } from '@/layers/widgets/room-view';
import type { MessageAuthor } from '@/layers/shared/model';
import type { AuthorRef, RoomEntry } from '@/layers/entities/room';
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
import { buildRoomTarget, buildSessionTarget } from './ComposerShowcases';

/** The one fixture: four turns of a conversation, oldest first. */
const TURNS: readonly { from: 'human' | 'agent'; text: string }[] = [
  { from: 'human', text: 'Can you check why the deploy is stuck?' },
  { from: 'agent', text: 'Looking at the deploy logs now.' },
  { from: 'agent', text: 'Found it — the migration step timed out waiting on a lock.' },
  { from: 'human', text: 'Can you retry it, once the lock clears?' },
];

/** The same turns, as a session's messages. */
const SESSION_ROWS: ConversationRow[] = TURNS.map((turn, index) => {
  const message =
    turn.from === 'human'
      ? createUserMessage({ content: turn.text })
      : createAssistantMessage({ content: turn.text });
  return {
    kind: 'message',
    id: `session-row-${index}`,
    payload: message,
    grouping: { position: 'only' },
    author:
      turn.from === 'human'
        ? BENCH_VIEWER
        : { kind: 'agent', id: 'dorkbot', displayName: 'DorkBot' },
    at: message.timestamp,
  };
});

/** The same turns, as room entries — with each row's roster author alongside it. */
const ROOM_ENTRIES: readonly {
  entry: RoomEntry;
  author: MessageAuthor;
  authorRef: AuthorRef & { origin: 'local' };
}[] = TURNS.map((turn) => ({
  entry: benchEntry(turn.text, {
    authorId: turn.from === 'human' ? BENCH_VIEWER_ID : BENCH_AGENT.id,
  }),
  author: turn.from === 'human' ? BENCH_VIEWER : BENCH_AGENT,
  authorRef: turn.from === 'human' ? BENCH_VIEWER_REF : BENCH_AGENT_REF,
}));

const ROOM_ROWS: ConversationRow[] = ROOM_ENTRIES.map(({ entry, author }, index) => ({
  kind: 'message',
  id: `room-row-${index}`,
  payload: entry,
  grouping: { position: 'only' },
  author,
  at: entry.createdAt,
}));

/** An idle lane — nobody working, nothing waiting. Every column starts here. */
function idleLane(capabilities: ConversationCapabilities) {
  return deriveLaneState({ capabilities, asks: NO_ASKS, stalled: false, presence: [], turn: null });
}

/** One column: a real Root holding a real Timeline, LiveLane and Composer. */
function SurfaceColumn({
  surface,
  label,
  capabilities,
  placeholder,
}: {
  surface: ConversationSurface;
  label: string;
  capabilities: ConversationCapabilities;
  placeholder: string;
}) {
  const target =
    surface === 'session' ? buildSessionTarget({ placeholder }) : buildRoomTarget({ placeholder });
  const rows = surface === 'session' ? SESSION_ROWS : ROOM_ROWS;

  return (
    <div className="min-w-0 flex-1">
      <p className="text-muted-foreground mb-2 text-[10px] tracking-wide uppercase">{label}</p>
      <Conversation.Root
        surface={surface}
        capabilities={capabilities}
        target={target}
        anchor={surface === 'session' ? 'corner' : 'rail'}
      >
        <div
          className="border-border bg-background flex flex-col overflow-hidden rounded-lg border"
          style={{ height: 360 }}
        >
          <Conversation.Timeline
            conversationId={`bench-${surface}`}
            label={`${label} history`}
            rows={rows}
            renderRow={(row) => {
              if (row.kind !== 'message') return null;
              if (surface === 'session') {
                return (
                  <SessionMessage
                    message={row.payload as ReturnType<typeof createUserMessage>}
                    grouping={row.grouping}
                    author={row.author}
                    sessionId={MOCK_SESSION_ID}
                  />
                );
              }
              const index = Number(row.id.split('-').pop());
              const seeded = ROOM_ENTRIES[index]!;
              return (
                <RoomMessage
                  roomId={BENCH_ROOM_ID}
                  entry={seeded.entry}
                  author={seeded.author}
                  authorRef={seeded.authorRef}
                  authors={BENCH_AUTHORS}
                  viewerAuthorId={BENCH_VIEWER_ID}
                  authorNames={BENCH_NAMES}
                  reactionFrequents={BENCH_FREQUENTS}
                  grouping={row.grouping}
                />
              );
            }}
          />
          <Conversation.LiveLane
            state={idleLane(capabilities)}
            scope={surface === 'session' ? 'session' : 'room'}
          />
          <Conversation.Composer
            value=""
            onChange={() => {}}
            onSubmit={() => {}}
            input={{ placeholder, isStreaming: false }}
          />
        </div>
      </Conversation.Root>
    </div>
  );
}

/**
 * Session, room and DM, side by side from the one fixture above. This is the
 * section that makes a regression in the unification visible at a glance.
 */
export function SurfacesShowcase() {
  return (
    <PlaygroundSection
      title="Surfaces"
      description="The same four turns, drawn through the three capability objects a real cockpit chooses between. Each column is a genuine Conversation.Root — Timeline, LiveLane and Composer included — never a recreation. A DM is a room whose surface differs in name only, so it draws from the same ROOM_CAPABILITIES and the same rows as the room column."
    >
      <ShowcaseLabel>Session · Room · DM</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="flex flex-col gap-4 lg:flex-row">
          <SurfaceColumn
            surface="session"
            label="Session"
            capabilities={SESSION_CAPABILITIES}
            placeholder="Message DorkBot…"
          />
          <SurfaceColumn
            surface="room"
            label="Room"
            capabilities={ROOM_CAPABILITIES}
            placeholder="Message #release-train…"
          />
          <SurfaceColumn
            surface="dm"
            label="DM"
            capabilities={ROOM_CAPABILITIES}
            placeholder="Message Ana…"
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
