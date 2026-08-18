/**
 * The one row every messaging surface draws, and the two rules that separate it.
 *
 * Benched against the REAL `Message.*` parts rather than a copy of their markup:
 * the whole claim of this section is that a channel row and a session row are
 * one component, and a recreation is the one thing incapable of showing that
 * claim breaking.
 *
 * @module dev/showcases/MessageRowShowcases
 */
import {
  Conversation,
  DayDivider,
  Message,
  UnreadDivider,
  type ConversationCapabilities,
} from '@/layers/features/conversation';
import { SESSION_CAPABILITIES } from '@/layers/features/chat';
import { ROOM_CAPABILITIES } from '@/layers/widgets/room-view';
import type { MessageGrouping } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { AGENT_AUTHOR, HUMAN_AUTHOR, MOCK_SESSION_ID } from '../mock-chat-data';

/** Both of this file's sections, in the order the Chat page draws them. */
export function MessageRowShowcases() {
  return (
    <>
      <MessageMatrixShowcase />
      <ConversationDividersShowcase />
    </>
  );
}

/** A message with no reactions on it yet, so the pill row draws nothing. */
const NO_REACTIONS: never[] = [];

/** One row of the matrix, drawn from the REAL parts. */
function BenchRow({
  capabilities,
  anchor,
  voice,
  position = 'only',
  density = 'comfortable',
  body,
}: {
  capabilities: ConversationCapabilities;
  anchor: 'corner' | 'rail';
  /**
   * Whose voice the row is in — `Message.Root`'s `role` variant, named `voice`
   * here because `jsx-a11y` reads a literal `role=` on any JSX element as an
   * ARIA role, and this one is typography. The DOM role is `article` either way.
   */
  voice: 'user' | 'assistant';
  position?: MessageGrouping['position'];
  density?: 'comfortable' | 'compact';
  body?: string;
}) {
  return (
    <Conversation.Root
      surface={anchor === 'rail' ? 'room' : 'session'}
      capabilities={capabilities}
      anchor={anchor}
      density={density}
    >
      <Message.Root role={voice} position={position}>
        <Message.Gutter
          author={voice === 'user' ? HUMAN_AUTHOR : AGENT_AUTHOR}
          at="2026-08-18T09:45:00.000Z"
        />
        <Message.Body>
          <Message.Author
            author={voice === 'user' ? HUMAN_AUTHOR : AGENT_AUTHOR}
            at="2026-08-18T09:45:00.000Z"
          />
          <Message.Content>
            {body ?? 'the deploy is stuck — the last step never returned'}
          </Message.Content>
          <Message.Reactions
            reactions={NO_REACTIONS}
            viewerAuthorId="human"
            names={new Map()}
            frequents={['👍', '🎉', '👀']}
            onToggle={() => {}}
            onExit={() => {}}
          />
          <Message.Actions
            reactions={{ quick: ['👍', '🎉', '👀'], mine: [], onToggle: () => {} }}
            runWith={{ prompt: 'ship it', sessionId: MOCK_SESSION_ID }}
            onExit={() => {}}
          />
        </Message.Body>
      </Message.Root>
    </Conversation.Root>
  );
}

/** Capability tables the matrix varies one flag at a time from. */
const NO_CAPABILITIES: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: false,
  attachments: false,
  toolCards: false,
  mentions: false,
  presence: false,
  turnStatus: false,
  asks: false,
};

/**
 * The one row, and everything that can change about it.
 *
 * Hover any row below: what appears is decided by the CAPABILITY table above
 * it and by nothing else. The two shipped tables are drawn first, side by side,
 * because "a channel row and a session row are the same component" is the claim
 * this whole section exists to make checkable at a glance.
 */
function MessageMatrixShowcase() {
  return (
    <PlaygroundSection
      title="Message.* matrix"
      description="One row, composed from Message.Root · Gutter · Author · Body · Content · Attachments · Reactions · Actions. Look is decided by variants (anchor, role, position, density) and behaviour by capability flags — a channel has reactions and no “Run this with…”, a session has the opposite, and the component is identical. Hover each row to see its capsule. `threads` shows up as the reply line under a thread root (benched on the Rooms page, not duplicated here) and `toolCards` inside the host’s own body renderer, so neither has anything to show on the row itself."
    >
      <ShowcaseLabel>The two shipped conversations, same row, same fixture</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-muted-foreground mb-1 text-xs">
              Channel — reactions, threads, rail anchor
            </p>
            <BenchRow capabilities={ROOM_CAPABILITIES} anchor="rail" voice="assistant" />
          </div>
          <div>
            <p className="text-muted-foreground mb-1 text-xs">
              Session — run with, tool cards, corner anchor
            </p>
            <BenchRow capabilities={SESSION_CAPABILITIES} anchor="corner" voice="assistant" />
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>anchor — where the capsule is held (hover both)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col gap-4">
          <BenchRow capabilities={ROOM_CAPABILITIES} anchor="corner" voice="assistant" />
          <BenchRow capabilities={ROOM_CAPABILITIES} anchor="rail" voice="assistant" />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>role — the two voices, typography only</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col">
          <BenchRow
            capabilities={SESSION_CAPABILITIES}
            anchor="corner"
            voice="user"
            body="can you look at the build?"
          />
          <BenchRow capabilities={SESSION_CAPABILITIES} anchor="corner" voice="assistant" />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>position — the group’s vertical rhythm</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col">
          {(['first', 'middle', 'last'] as const).map((position) => (
            <BenchRow
              key={position}
              capabilities={ROOM_CAPABILITIES}
              anchor="rail"
              voice="assistant"
              position={position}
              body={`position="${position}"`}
            />
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>density — comfortable, then compact</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col gap-2">
          <BenchRow capabilities={ROOM_CAPABILITIES} anchor="rail" voice="assistant" />
          <BenchRow
            capabilities={ROOM_CAPABILITIES}
            anchor="rail"
            voice="assistant"
            density="compact"
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>capabilities — one flag at a time (hover each)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-muted-foreground mb-1 text-xs">nothing on — a bare row</p>
            <BenchRow capabilities={NO_CAPABILITIES} anchor="rail" voice="assistant" />
          </div>
          <div>
            <p className="text-muted-foreground mb-1 text-xs">reactions on — the quick row</p>
            <BenchRow
              capabilities={{ ...NO_CAPABILITIES, reactions: true }}
              anchor="rail"
              voice="assistant"
            />
          </div>
          <div>
            <p className="text-muted-foreground mb-1 text-xs">run-with on — the shuffle trigger</p>
            <BenchRow
              capabilities={{ ...NO_CAPABILITIES, runWith: true }}
              anchor="corner"
              voice="user"
            />
          </div>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * The two rules that separate a transcript, drawn by the same components a room
 * and a session both render.
 *
 * They moved into `features/conversation` with the rest of the row family; this
 * is the first bench either has had. The room's other three moved rows — the
 * notice, the moment and the thread reply line — are benched on the Rooms page
 * against real room fixtures, so they are not drawn a second time here.
 */
function ConversationDividersShowcase() {
  return (
    <PlaygroundSection
      title="Conversation dividers"
      description="The full-bleed day boundary and the “New messages” rule. Both are list-level rows rather than message decoration, both are separators between articles rather than articles themselves, and both are drawn identically in a channel and in a session."
    >
      <ShowcaseLabel>Day boundary</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex w-full flex-col">
          <DayDivider label="Today" />
          <DayDivider label="Monday, July 21" />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Where the reader left off</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex w-full flex-col">
          <UnreadDivider />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
