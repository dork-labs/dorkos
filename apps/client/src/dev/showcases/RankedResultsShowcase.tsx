/**
 * The ⌘K ranked-result list, drawn by the shipped scorer (design-decisions §15).
 *
 * Its own file because `CommandPaletteShowcases.tsx` was already past the
 * 500-line limit before this section existed, and because the whole point of it
 * is that the ORDER is not authored here: the mock corpus goes through
 * `rankCandidates` / `selectBestMatch` / `groupRankedRows` and the rows through
 * `PaletteResultRow`, so this page is wrong only when the product is.
 *
 * @module dev/showcases/RankedResultsShowcase
 */
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Command, CommandInput, CommandList, CommandGroup } from '@/layers/shared/ui';
import {
  BEST_MATCH_HEADING,
  PaletteResultRow,
  RESULT_GROUP_LABEL,
  groupRankedRows,
  rankCandidates,
  selectBestMatch,
  type RankCandidate,
  type SearchResult,
} from '@/layers/features/command-palette';
import { MOCK_AGENTS, SESSION_ROWS } from './command-palette-fixtures';

/**
 * The instant these showcases rank against, read once at module load.
 *
 * The scorer takes its clock as an argument precisely so a caller can hold it
 * still; reading it during render would make this component impure for no gain,
 * since the mock timestamps below are all relative to page load anyway.
 */
const SHOWCASE_NOW = Date.now();

/** The ranking fields of a showcase row with no history behind it. */
const UNUSED_ROW = {
  usageKey: null,
  lastActivityAt: null,
  waiting: false,
  demoted: false,
} as const;

/**
 * A corpus for the query `side`, built so the ranking has to interleave kinds.
 *
 * The `distance` values are real Fuse-shaped scores: near-zero for an exact hit,
 * a few thousandths for a near miss. They are the scorer's actual input, so the
 * list below is produced by the shipped ranker rather than drawn by hand.
 */
const RANKED_CORPUS: RankCandidate<SearchResult>[] = [
  {
    key: 'session:sess-live',
    item: {
      item: {
        id: 'sess-live',
        name: 'Sidebar zones rewrite',
        type: 'session',
        ...UNUSED_ROW,
        data: SESSION_ROWS[0],
      },
      matches: undefined,
    },
    distance: 0.0001,
    usage: { lastUsedAt: SHOWCASE_NOW - 20 * 60_000, useCount: 6 },
    lastActivityAt: SHOWCASE_NOW - 60_000,
    waiting: false,
    demoted: false,
  },
  {
    key: 'agent:agent-frontend',
    item: {
      item: {
        id: 'agent-frontend',
        name: 'Frontend App',
        type: 'agent',
        keywords: ['sidebar'],
        ...UNUSED_ROW,
        data: MOCK_AGENTS[0],
      },
      matches: undefined,
    },
    distance: 0.004,
    usage: { lastUsedAt: SHOWCASE_NOW - 3 * 60 * 60_000, useCount: 12 },
    lastActivityAt: SHOWCASE_NOW - 3 * 60 * 60_000,
    waiting: false,
    demoted: false,
  },
  {
    key: 'session:sess-recent',
    item: {
      item: {
        id: 'sess-recent',
        name: 'Rate limiting for the relay',
        type: 'session',
        keywords: ['sidebar'],
        ...UNUSED_ROW,
        data: SESSION_ROWS[1],
      },
      matches: undefined,
    },
    distance: 0.005,
    usage: { lastUsedAt: null, useCount: 0 },
    lastActivityAt: SHOWCASE_NOW - 35 * 60_000,
    waiting: false,
    demoted: false,
  },
  {
    key: 'agent:agent-docs',
    item: {
      item: {
        id: 'agent-docs',
        name: 'Documentation',
        type: 'agent',
        keywords: ['side'],
        ...UNUSED_ROW,
        data: MOCK_AGENTS[2],
      },
      matches: undefined,
    },
    distance: 0.012,
    usage: { lastUsedAt: null, useCount: 0 },
    lastActivityAt: null,
    waiting: false,
    demoted: false,
  },
];

/** Draw one ranked list exactly as `PaletteRootPage` does. */
function RankedList({ corpus }: { corpus: RankCandidate<SearchResult>[] }) {
  const ranked = rankCandidates(corpus, SHOWCASE_NOW);
  const { best, rest } = selectBestMatch(ranked, { queried: true });
  const groups = groupRankedRows(rest, (row) => RESULT_GROUP_LABEL[row.item.item.type]);
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
  return (
    <Command className="rounded-lg border" shouldFilter={false}>
      <CommandInput placeholder="Search rooms, agents, commands..." value="side" readOnly />
      <CommandList>
        {best && (
          <CommandGroup heading={BEST_MATCH_HEADING}>
            <PaletteResultRow row={best} {...rowProps} />
          </CommandGroup>
        )}
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

/** Two ranked lists: one with a Best match, one where no row earned it. */
export function RankedResults() {
  // The same corpus with the leader's advantage removed, so the two demos differ
  // only in whether a row stands clear.
  const levelled: RankCandidate<SearchResult>[] = RANKED_CORPUS.map((c, i) =>
    i === 0 ? { ...c, distance: 0.0045, usage: { lastUsedAt: null, useCount: 0 } } : c
  );

  return (
    <div className="space-y-4">
      <ShowcaseLabel>
        One ranked list — a strong conversation match above an agent, and the headings following the
        ranking rather than deciding it
      </ShowcaseLabel>
      <ShowcaseDemo>
        <RankedList corpus={RANKED_CORPUS} />
      </ShowcaseDemo>

      <ShowcaseLabel>
        No Best match — the top two rows are the same answer twice, so the list stands alone and is
        not reordered to compensate
      </ShowcaseLabel>
      <ShowcaseDemo>
        <RankedList corpus={levelled} />
      </ShowcaseDemo>
    </div>
  );
}
