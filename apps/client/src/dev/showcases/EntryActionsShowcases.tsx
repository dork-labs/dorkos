import { AtSign, Copy, Reply } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { MessageAuthor, MessageGrouping } from '@/layers/shared/model';
import type { AuthorRef, RoomEntry } from '@/layers/entities/room';
import { Conversation, messageItem } from '@/layers/features/conversation';
import { EntryActionBar, type EntryAction } from '@/layers/features/entry-actions';
import { ROOM_CAPABILITIES, RoomMessage } from '@/layers/widgets/room-view';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';
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
  TALL_TEXT,
  benchEntry,
  benchReaction,
} from './entry-actions-showcase-data';

/** The toolbar's own look, taken from the variant the rooms surface uses. */
const railActions = messageItem({ anchor: 'rail' }).actions();

interface BenchRowProps {
  /** The seeded entry to draw. */
  entry: RoomEntry;
  /** Who wrote it. Defaults to the agent, so the reader can mention them. */
  author?: MessageAuthor;
  /** The same author as a roster holds them, or undefined for a former member. */
  authorRef?: (AuthorRef & { origin: 'local' }) | undefined;
  /** Where the row sits in its author group. */
  grouping?: MessageGrouping;
  /** True to draw the row as a room whose live stream has given up. */
  stalled?: boolean;
}

/**
 * One seeded room row, with the bench's defaults already applied.
 *
 * This is the REAL `RoomMessage` — the toolbar's enclosure is held by layout
 * the row itself owns (a zero-height sticky rail), so a copy of its markup
 * would be the one thing incapable of showing a layout defect.
 */
function BenchRow({
  entry,
  author = BENCH_AGENT,
  authorRef = BENCH_AGENT_REF,
  grouping = { position: 'only' },
  stalled,
}: BenchRowProps) {
  return (
    <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
      <RoomMessage
        roomId={BENCH_ROOM_ID}
        entry={entry}
        author={author}
        authorRef={authorRef}
        authors={BENCH_AUTHORS}
        viewerAuthorId={BENCH_VIEWER_ID}
        authorNames={BENCH_NAMES}
        reactionFrequents={BENCH_FREQUENTS}
        streamStalled={stalled}
        grouping={grouping}
      />
    </Conversation.Root>
  );
}

const STRADDLE_ENTRY = benchEntry('the deploy is stuck — the last step never returned');

/** Where the capsule lands against the message it acts on. */
function StraddleSection() {
  return (
    <PlaygroundSection
      title="Where the capsule sits"
      description="The capsule straddles the message's top-right edge — about half of it above the block, in the air between messages — so while that edge is on screen it covers no word of what it acts on. Its rail is a band exactly one capsule tall, hung above the message's first line, which is what makes that true by construction rather than by a number somebody picked. (Scrolled past its own top, a message hands the capsule to the sticky clamp, which is the one place it sits over words — see the sticky rail below.)"
    >
      <p className="text-muted-foreground mb-2 text-xs">
        Hover the row and read the bottom edge of the pill: it should rest ON the line the author's
        name sits on, never over it. Move away and back to watch it arrive — a fade with a small
        rise that overshoots a pixel and settles. Leaving is a plain, faster fade with nothing
        moving.
      </p>
      <ShowcaseDemo responsive>
        <BenchRow entry={STRADDLE_ENTRY} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

const HOVER_ENTRY = benchEntry('the lockfile changed under us, that is the whole story');
const FOCUS_ENTRY = benchEntry('worth checking whether the cache warmed at all');

/** Hover and keyboard focus — the two ways the toolbar is revealed on a pointer device. */
function RevealSection() {
  return (
    <PlaygroundSection
      title="Revealing the toolbar"
      description="The toolbar is always in the DOM and revealed by opacity, never mounted on demand — so it can be reached with a pointer or with a key, and neither path shifts the row. Touch gets the long-press drawer instead and is deliberately left out of both rules below."
    >
      <div>
        <ShowcaseLabel>On hover</ShowcaseLabel>
        <p className="text-muted-foreground mb-2 text-xs">
          Put the pointer on the row. The pill should rise into place above the message and fully
          enclose its icons, with its own padding visible above and below them.
        </p>
        <ShowcaseDemo responsive>
          <BenchRow entry={HOVER_ENTRY} />
        </ShowcaseDemo>
      </div>

      <div>
        <ShowcaseLabel>On focus</ShowcaseLabel>
        <p className="text-muted-foreground mb-2 text-xs">
          Click the row (or Tab to it) and press an arrow key. The message is the tab stop; the
          buttons inside it are not, which is what keeps a room one Tab per message however many
          actions each one carries. Escape hands focus back to the row. The keyboard gets the same
          arrival the pointer does.
        </p>
        <ShowcaseDemo responsive>
          <BenchRow entry={FOCUS_ENTRY} />
        </ShowcaseDemo>
      </div>
    </PlaygroundSection>
  );
}

const TALL_ENTRY = benchEntry(TALL_TEXT);

/** The sticky rail on a message taller than what is on screen. */
function StickyRailSection() {
  return (
    <PlaygroundSection
      title="The sticky rail"
      description="A toolbar anchored to the top of the message goes off screen the moment the message is longer than the window — the hole Slack's top-anchored toolbar has. The rail is sticky instead, so the capsule straddles the message's top edge while that is on screen and clamps to the scroller's edge once the message extends above it. Past the clamp there is no edge left to straddle, so it stops straddling and rides the edge, whole and in the way of as little as possible."
    >
      <p className="text-muted-foreground mb-2 text-xs">
        Scroll this box slowly past the message&apos;s own top, then hover. The pill should travel
        up with the message and simply stop at the top edge — no jump at the handover — and stay
        pinned there, still whole, still holding its buttons. Stop the scroll just as the first line
        clears the edge and the pill sits over it: the clamp is where the no-occlusion promise runs
        out, and it is the price of the actions staying reachable at all.
      </p>
      <ShowcaseDemo>
        <div className="bg-background h-[360px] overflow-y-auto rounded-md border">
          <BenchRow entry={TALL_ENTRY} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

const MINE_ENTRY = benchEntry('shipping it now', {
  authorId: BENCH_VIEWER_ID,
});
const THEIRS_ENTRY = benchEntry('the cache was cold, so every package rebuilt');
const DEPARTED_ENTRY = benchEntry('I moved the job to the nightly runner before I left');

const ONE_REACTION = benchEntry('rerunning it clean now', {
  reactions: [benchReaction('👍', [BENCH_VIEWER_ID])],
});
const THREE_REACTIONS = benchEntry('green on the second run — the cache was just cold', {
  reactions: [
    benchReaction('👍', ['author-lifeos', BENCH_VIEWER_ID]),
    benchReaction('🎉', ['author-mio']),
    benchReaction('👀', ['author-lifeos', 'author-mio', 'author-gone']),
  ],
});
const MANY_REACTIONS = benchEntry('shipped — thanks everyone', {
  reactions: [
    ...['👍', '❤️', '🎉', '🚀', '🔥', '👀', '💯', '🙏', '👏', '⭐'].map((emoji, i) =>
      benchReaction(emoji, i === 0 ? ['author-lifeos', BENCH_VIEWER_ID] : ['author-lifeos'])
    ),
    benchReaction('🏆', ['author-mio']),
    benchReaction('✨', ['author-mio']),
    benchReaction('🧠', ['author-mio']),
  ],
});
const STALLED_REACTIONS = benchEntry('the room stopped listening while this was on screen', {
  reactions: [benchReaction('👍', [BENCH_VIEWER_ID])],
});

/** The pills under a message, at every count the design has an answer for. */
function ReactionsSection() {
  return (
    <PlaygroundSection
      title="Reactions under a message"
      description="Five behaviours, all approved (design record §2). The pill you added carries the accent and IS the toggle; hovering names names rather than counting; arrival pops with a ring burst while removal is a plain fade; and once a message has any reaction a faint 🙂+ ends the row. A message with none draws nothing here at all — no rail, no ghost — which is the behaviour the first row below exists to show."
    >
      <div>
        <ShowcaseLabel>None — the clean case</ShowcaseLabel>
        <p className="text-muted-foreground mb-2 text-xs">
          Nothing under the words. Not a faint +, not an empty band: the capsule is the whole
          affordance until there is a reaction for a ghost to sit beside.
        </p>
        <ShowcaseDemo responsive>
          <BenchRow entry={benchEntry('nobody has reacted to this one')} />
        </ShowcaseDemo>
      </div>

      <div>
        <ShowcaseLabel>One — and it is yours</ShowcaseLabel>
        <p className="text-muted-foreground mb-2 text-xs">
          The accent border and warmer fill mark the pill as yours; press it again and it goes.
          Hover it to read who is on it. The 🙂+ at the row&apos;s end opens the same picker the
          capsule&apos;s does.
        </p>
        <ShowcaseDemo responsive>
          <BenchRow entry={ONE_REACTION} />
        </ShowcaseDemo>
      </div>

      <div>
        <ShowcaseLabel>Three — one yours, two not</ShowcaseLabel>
        <p className="text-muted-foreground mb-2 text-xs">
          Only the first glows. The last pill includes somebody who has since left the room, whose
          tooltip says exactly that rather than showing a raw id.
        </p>
        <ShowcaseDemo responsive>
          <BenchRow entry={THREE_REACTIONS} />
        </ShowcaseDemo>
      </div>

      <div>
        <ShowcaseLabel>Thirteen — wraps to ten, then “+3 more”</ShowcaseLabel>
        <p className="text-muted-foreground mb-2 text-xs">
          Past ten the row would be taller than the message it is about, so it stops and offers the
          rest. Press it: a count with nowhere to go would be naming reactions you cannot reach.
        </p>
        <ShowcaseDemo responsive>
          <BenchRow entry={MANY_REACTIONS} />
        </ShowcaseDemo>
      </div>

      <div>
        <ShowcaseLabel>A room that has stopped listening</ShowcaseLabel>
        <p className="text-muted-foreground mb-2 text-xs">
          Reactions go with the composer (design record §4). The pill, the ghost + and the
          capsule&apos;s quick row all refuse the press, because a write whose answer would never
          come back is worse than a control that says it cannot be used.
        </p>
        <ShowcaseDemo responsive>
          <BenchRow entry={STALLED_REACTIONS} stalled />
        </ShowcaseDemo>
      </div>
    </PlaygroundSection>
  );
}

/** Inert stand-ins for the action set, so the pill can be seen at each width. */
const SPECIMEN_ACTIONS: EntryAction[] = [
  { id: 'reply', label: 'Reply in thread', icon: Reply, run: () => {} },
  { id: 'copy', label: 'Copy text', icon: Copy, run: () => {} },
  { id: 'mention', label: 'Mention Ana', icon: AtSign, run: () => {} },
];

/** An inert quick row, so the capsule can be drawn at its live width. */
const SPECIMEN_REACTIONS = {
  quick: BENCH_FREQUENTS,
  mine: ['👍'],
  onToggle: () => {},
};

/**
 * A standalone bar, shown without hover so the pill's shape can be read at each
 * width. `opacity-100` is the only thing overridden — an appearance the row
 * itself only reaches on hover, held open here so a still image can carry it.
 */
function Specimen({ count, withReactions }: { count: number; withReactions?: boolean }) {
  return (
    <div className="flex justify-start">
      <EntryActionBar
        actions={SPECIMEN_ACTIONS.slice(0, count)}
        reactions={withReactions === true ? SPECIMEN_REACTIONS : undefined}
        onExit={() => {}}
        className={cn(railActions, 'pointer-events-auto opacity-100')}
      />
    </div>
  );
}

/** How the pill changes shape with the number of actions in it. */
function ActionCountSection() {
  return (
    <PlaygroundSection
      title="How many actions"
      description="Reply and Copy are always offered; Mention appears only when an @ would actually reach the author — so a live capsule carries six or seven slots once its three quick reactions and the picker are counted. The bar is also shown below at widths no live row produces today."
    >
      <div>
        <ShowcaseLabel>Two — your own message</ShowcaseLabel>
        <p className="text-muted-foreground mb-2 text-xs">
          No Mention: you are never offered a mention of yourself, the same way the mention picker
          leaves you out.
        </p>
        <ShowcaseDemo>
          <BenchRow entry={MINE_ENTRY} author={BENCH_VIEWER} authorRef={BENCH_VIEWER_REF} />
        </ShowcaseDemo>
      </div>

      <div>
        <ShowcaseLabel>Two — an author no @ can reach</ShowcaseLabel>
        <p className="text-muted-foreground mb-2 text-xs">
          Someone who has left the room has no mention handle, and offering a mention that silently
          addresses nobody is worse than not offering one.
        </p>
        <ShowcaseDemo>
          <BenchRow entry={DEPARTED_ENTRY} authorRef={undefined} />
        </ShowcaseDemo>
      </div>

      <div>
        <ShowcaseLabel>Three — somebody else, still in the room</ShowcaseLabel>
        <ShowcaseDemo>
          <BenchRow entry={THEIRS_ENTRY} />
        </ShowcaseDemo>
      </div>

      <div>
        <ShowcaseLabel>The whole capsule — reactions, divider, commands</ShowcaseLabel>
        <p className="text-muted-foreground mb-2 text-xs">
          Seven buttons at its widest: three quick emoji, the picker, then reply, copy and mention,
          with a divider ruled between the reactions and the commands. The 👍 is drawn as one the
          reader already left, which is how a quick-row button says the message already carries
          yours.
        </p>
        <ShowcaseDemo>
          <div className="flex flex-col items-start gap-3">
            <Specimen count={3} withReactions />
            <Specimen count={2} withReactions />
          </div>
        </ShowcaseDemo>
      </div>

      <div>
        <ShowcaseLabel>The pill on its own — one, two, three</ShowcaseLabel>
        <p className="text-muted-foreground mb-2 text-xs">
          The bar alone, held open without hover. Every icon sits inside the border with even
          padding around it at every width — including one, which no live row produces today but
          which the bar is asked to draw the moment the set is filtered any harder.
        </p>
        <ShowcaseDemo>
          <div className="flex flex-col items-start gap-3">
            <Specimen count={1} />
            <Specimen count={2} />
            <Specimen count={3} />
          </div>
        </ShowcaseDemo>
      </div>
    </PlaygroundSection>
  );
}

const GROUP_FIRST = benchEntry('I can take the deploy if nobody else has it');
const GROUP_MIDDLE = benchEntry('the lockfile changed under us, that is the whole story');
const GROUP_LAST = benchEntry('rerunning it clean now');
const GROUP_ONLY = benchEntry('done — green on the second run');

/** The toolbar over a group start and over a continuation. */
function GroupingSection() {
  return (
    <PlaygroundSection
      title="Grouped and ungrouped"
      description="A group start draws the avatar, the name and the time; a continuation hangs beneath it with an empty identity gutter and its own timestamp on hover. One rule covers both: the capsule hangs off the message's own first line, and the row's top padding already moves with the grouping — so a group start gets the even straddle, and a continuation, which has only 12px of air to work with, reaches further up into it."
    >
      <div>
        <ShowcaseLabel>A group — first, middle, last</ShowcaseLabel>
        <p className="text-muted-foreground mb-2 text-xs">
          Hover each row in turn. A 30px capsule cannot fit in the 12px between grouped messages, so
          on a continuation it reaches over the line above — never over the message it acts on,
          which is the one you are pointing at and about to do something to.
        </p>
        <ShowcaseDemo responsive>
          <BenchRow entry={GROUP_FIRST} grouping={{ position: 'first' }} />
          <BenchRow entry={GROUP_MIDDLE} grouping={{ position: 'middle' }} />
          <BenchRow entry={GROUP_LAST} grouping={{ position: 'last' }} />
        </ShowcaseDemo>
      </div>

      <div>
        <ShowcaseLabel>On its own</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <BenchRow entry={GROUP_ONLY} grouping={{ position: 'only' }} />
        </ShowcaseDemo>
      </div>
    </PlaygroundSection>
  );
}

const THEME_ENTRY = benchEntry(
  'the pill has to be opaque — the words under it must not show through'
);

/** The same row on both surfaces the cockpit is read on. */
function ThemeSection() {
  return (
    <PlaygroundSection
      title="Both themes"
      description="The toolbar is drawn ON TOP of a paragraph, so its surface has to be opaque and its shadow has to read against the page behind it. The first row follows the playground's own theme (the toggle at the foot of the sidebar); the second is pinned dark, so a light page can show both at once."
    >
      <div>
        <ShowcaseLabel>The playground&apos;s theme</ShowcaseLabel>
        <ShowcaseDemo>
          <BenchRow entry={THEME_ENTRY} />
        </ShowcaseDemo>
      </div>

      <div>
        <ShowcaseLabel>Pinned dark</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="dark bg-background text-foreground rounded-md border p-2">
            <BenchRow entry={THEME_ENTRY} />
          </div>
        </ShowcaseDemo>
      </div>
    </PlaygroundSection>
  );
}

/**
 * The message action surface, on the real room row that carries it.
 *
 * This bench exists because of a defect that every non-visual check passed: the
 * toolbar was in the right place, clickable, and correctly named while it
 * rendered as a thin capsule with its buttons hanging out of it top and bottom.
 * Position and clickability could not see it. A person looking at it could.
 */
export function EntryActionsShowcases() {
  return (
    <>
      <StraddleSection />
      <RevealSection />
      <ReactionsSection />
      <StickyRailSection />
      <ActionCountSection />
      <GroupingSection />
      <ThemeSection />
    </>
  );
}
