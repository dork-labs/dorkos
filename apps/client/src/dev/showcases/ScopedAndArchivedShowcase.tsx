/**
 * The last two ⌘K states P3 shipped: a list scoped by a chip, and rows that say
 * they are archived (design-decisions §15, P3 AC-5/AC-6).
 *
 * Its own file for the same reason `RankedResultsShowcase` has one — and under
 * the same rule: **nothing here is drawn by hand.** The chip is
 * `PaletteScopeChip`, the heading comes from `scopeHeading`, the order comes
 * from `rankCandidates`, and every row is a `PaletteResultRow` or the shipped
 * `SessionCommandItem` / `RoomCommandItem` inside a real cmdk root. A showcase
 * that redraws a row is a showcase that can be right about a component that has
 * been wrong for a month.
 *
 * @module dev/showcases/ScopedAndArchivedShowcase
 */
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Command, CommandInput, CommandList, CommandGroup } from '@/layers/shared/ui';
import {
  PaletteResultRow,
  PaletteScopeChip,
  RoomCommandItem,
  SessionCommandItem,
  groupRankedRows,
  rankCandidates,
  scopeHeading,
  type PaletteScope,
  type RankCandidate,
  type SearchResult,
} from '@/layers/features/command-palette';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { MOCK_AGENTS, sessionRow } from './command-palette-fixtures';

/** The instant these showcases rank against, read once at module load. */
const SHOWCASE_NOW = Date.now();

/** A channel, in the shape the room components read. */
function makeRoom(overrides: Partial<RoomSummary> & { id: string }): RoomSummary {
  return {
    kind: 'channel',
    slug: 'shipping',
    title: 'Shipping',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: new Date(SHOWCASE_NOW - 90 * 24 * 3600_000).toISOString(),
    lastActivityAt: new Date(SHOWCASE_NOW - 40 * 60_000).toISOString(),
    unreadCount: null,
    participants: null,
    ...overrides,
  };
}

const liveChannel = makeRoom({ id: 'room-shipping', slug: 'shipping', unreadCount: 2 });

/** A channel somebody closed. The palette is the only surface that lists one. */
const archivedChannel = makeRoom({
  id: 'room-shipping-2025',
  slug: 'shipping-2025',
  title: 'Shipping 2025',
  archived: true,
  lastActivityAt: new Date(SHOWCASE_NOW - 200 * 24 * 3600_000).toISOString(),
});

/** Scoped to an agent — "conversations WITH". */
const agentScope: PaletteScope = { kind: 'agent', agent: MOCK_AGENTS[0] };

/** Scoped to a channel — "conversations IN". Two prepositions, two relations. */
const roomScope: PaletteScope = { kind: 'room', room: liveChannel };

/** One conversation as a candidate for the ranker. */
function sessionCandidate(id: string, distance: number): RankCandidate<SearchResult> {
  const session = sessionRow(id);
  return {
    key: `session:${session.id}`,
    item: {
      item: {
        id: session.id,
        name: session.title,
        type: 'session',
        usageKey: null,
        lastActivityAt: session.lastActivityAt,
        waiting: false,
        demoted: false,
        scopes: [],
        data: session,
      },
      matches: undefined,
    },
    distance,
    usage: { lastUsedAt: null, useCount: 0 },
    lastActivityAt: Date.parse(session.lastActivityAt),
    waiting: false,
    demoted: false,
  };
}

const rowProps = {
  selectedCwd: null,
  selectedValue: '',
  onFeatureAction: () => {},
  onQuickAction: () => {},
  onGoToAgentActions: () => {},
  onRoomSelect: () => {},
  onSessionSelect: () => {},
  onCommandSelect: () => {},
};

/**
 * A scoped list, drawn the way `PaletteRootPage` draws one: the chip sits in
 * the input's leading slot, and the single heading names the SCOPE rather than
 * the kind, because under a chip every row is a conversation.
 */
function ScopedList({
  scope,
  corpus,
}: {
  scope: PaletteScope;
  corpus: RankCandidate<SearchResult>[];
}) {
  const ranked = rankCandidates(corpus, SHOWCASE_NOW);
  const groups = groupRankedRows(ranked, () => scopeHeading(scope));
  return (
    <Command className="rounded-lg border" shouldFilter={false}>
      <CommandInput placeholder="Search within…" leading={<PaletteScopeChip scope={scope} />} />
      <CommandList>
        {groups.map((group, i) => (
          <CommandGroup key={`${group.label}-${i}`} heading={group.label}>
            {group.rows.map((row) => (
              <PaletteResultRow key={row.key} row={row} {...rowProps} />
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}

/** ⌘K scoped to one agent or one channel, with the chip saying which. */
export function ScopedPalette() {
  return (
    <div className="space-y-4">
      <ShowcaseLabel>
        Scoped to an agent — the chip says what you are looking inside, and the heading reads it
        back
      </ShowcaseLabel>
      <ShowcaseDemo>
        {/* Both rows belong to the scoped agent, because that is what a chip
            admits — a list under this heading holding somebody else's
            conversation would be a picture of the chip not filtering. */}
        <ScopedList
          scope={agentScope}
          corpus={[sessionCandidate('sess-live', 0.0002), sessionCandidate('sess-frontend-two', 0.004)]}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Scoped to a channel — a different preposition, because a conversation happens WITH an agent
        and IN a channel
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ScopedList scope={roomScope} corpus={[sessionCandidate('sess-from-shipping', 0.001)]} />
      </ShowcaseDemo>
    </div>
  );
}

/**
 * The one word two different kinds of row share.
 *
 * A channel is archived because somebody closed it; a conversation is archived
 * because it stopped being today's business at 4am. Both say the same thing to
 * the reader — still real, still openable, not part of what is happening now —
 * so both draw the same mark.
 */
export function ArchivedRows() {
  return (
    <div className="space-y-4">
      <ShowcaseLabel>
        A closed channel and a conversation from yesterday, beside their live neighbours
      </ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="rounded-lg border" shouldFilter={false}>
          <CommandInput placeholder="Search rooms, agents, commands..." value="ship" readOnly />
          <CommandList>
            <CommandGroup heading="Channels">
              <RoomCommandItem room={liveChannel} onSelect={() => {}} />
              <RoomCommandItem room={archivedChannel} onSelect={() => {}} />
            </CommandGroup>
            <CommandGroup heading="Conversations">
              <SessionCommandItem item={sessionRow('sess-recent')} onSelect={() => {}} />
              <SessionCommandItem item={sessionRow('sess-archived')} onSelect={() => {}} />
            </CommandGroup>
          </CommandList>
        </Command>
      </ShowcaseDemo>

      <ShowcaseLabel>
        A live row never carries it, whatever its stored timestamp says — “working…” beside
        “Archived” would be the row arguing with itself
      </ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="rounded-lg border" shouldFilter={false}>
          <CommandList>
            <CommandGroup heading="Continue">
              <SessionCommandItem
                item={sessionRow('sess-archived')}
                live={{ verb: 'Editing airtight-box.ts…', signal: 'working' }}
                isSelected
                onSelect={() => {}}
              />
            </CommandGroup>
          </CommandList>
        </Command>
      </ShowcaseDemo>
    </div>
  );
}
