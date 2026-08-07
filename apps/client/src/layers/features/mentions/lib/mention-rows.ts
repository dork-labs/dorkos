/**
 * The picker's row model: one flat, ordered list of rows, each tagged with the
 * section it renders under.
 *
 * **Sections are a grouping over one array, never separate arrays.** The whole
 * point of the `@` picker is that People and Agents sit under a single sigil, so
 * the keyboard has to cross the boundary between them without noticing it. A
 * row's position in this array is its selection index, its DOM id, and what
 * Enter inserts — one integer, so `aria-activedescendant` cannot drift from the
 * row the keyboard acts on. Sectioned rendering re-derives the headings from
 * `section` at paint time.
 *
 * @module features/mentions/lib/mention-rows
 */
import type { AuthorRef } from '@/layers/entities/room';

/** Which heading a row renders under. */
export type MentionSection = 'people' | 'agents';

/** Human-readable heading for each section. */
export const SECTION_LABELS: Record<MentionSection, string> = {
  people: 'People',
  agents: 'Agents',
};

/**
 * The order sections appear in, per host.
 *
 * Context-dependent by design: a room composer leads with the participants,
 * because addressing somebody is what an `@` means in a conversation. Both
 * sections stay reachable by typing regardless of order.
 */
export const ROOM_SECTION_ORDER: readonly MentionSection[] = ['people', 'agents'];

/** One selectable (or deliberately unselectable) row of the picker. */
export interface MentionRow {
  /** Which heading this row sits under. */
  section: MentionSection;
  /** The author id — a stable React key, and what the row is *about*. */
  authorId: string;
  /** What the row reads as: the author's display name. */
  label: string;
  /**
   * What gets written after the `@`, or `undefined` when nothing can be. The
   * server resolves the string that lands in the message, so this is the
   * server's own answer (`AuthorRef.handle`) rather than a name this side
   * picked — inserting anything else would post a mention that reaches nobody.
   */
  handle?: string;
  emoji?: string;
  color?: string;
  /** Never landed on by the keyboard, never inserted by a click. */
  disabled: boolean;
  /** Why, in one short phrase, shown on the row. Only set when `disabled`. */
  disabledReason?: string;
}

/**
 * Build the picker's rows from a room's roster.
 *
 * Three members never appear: the room's own voice (the `system` author, which
 * is not a participant), the reader themself (`@You` is the top row of every
 * room and means nothing), and anybody the roster lost the author record for.
 *
 * **Ownership is not re-derived here.** `handle` is already the answer to
 * "what reaches this member", decided server-side over the same name list and
 * the same order `resolveMentions` uses — including names this side never sees,
 * like a display name an earlier member quietly answers to. A second copy of
 * that rule on the client could only ever disagree with the first, and the way
 * it disagreed was by offering a handle that addressed somebody else. A member
 * with no handle is shown, disabled, saying so; a member with one has one that
 * works.
 *
 * @param members - The room's roster, as the server returned it.
 * @param viewerAuthorId - Who is reading; their own row is dropped.
 */
export function buildMentionRows(
  members: readonly { author: AuthorRef }[],
  viewerAuthorId: string
): MentionRow[] {
  const rows: MentionRow[] = [];

  for (const { author } of members) {
    if (author.kind === 'system' || author.id === viewerAuthorId) continue;

    const handle = author.handle;
    rows.push({
      section: author.kind === 'agent' ? 'agents' : 'people',
      authorId: author.id,
      label: author.displayName,
      ...(handle ? { handle } : {}),
      ...(author.emoji ? { emoji: author.emoji } : {}),
      ...(author.color ? { color: author.color } : {}),
      disabled: !handle,
      // Shown rather than filtered out: a member who quietly vanished from the
      // picker is worse than one who is there with a reason.
      ...(handle ? {} : { disabledReason: 'No @name' }),
    });
  }

  return rows;
}

/**
 * Filter and order the rows for a query, then lay the sections out end to end.
 *
 * Matching is deliberately **not** fuzzy. Handles are short, and a roster is a
 * dozen rows rather than a repository's worth of file paths, so the fuzzy ranker
 * the file picker uses would surface `@data-pipeline` for `ana` and read as a
 * malfunction. Three tiers instead — exact, then starts-with, then contains —
 * with roster order preserved inside each tier, so the list only ever reorders
 * for a reason a person can see.
 *
 * @param rows - Every candidate row, from {@link buildMentionRows}.
 * @param query - What was typed after the `@`, without the sigil.
 * @param sectionOrder - Which section leads. See {@link ROOM_SECTION_ORDER}.
 * @returns The rows to draw, flat and in final order.
 */
export function filterMentionRows(
  rows: readonly MentionRow[],
  query: string,
  sectionOrder: readonly MentionSection[]
): MentionRow[] {
  const needle = query.trim().toLowerCase();

  const ranked = rows
    .map((row, position) => ({ row, position, tier: matchTier(row, needle) }))
    .filter((candidate) => candidate.tier !== null)
    .sort((a, b) => a.tier! - b.tier! || a.position - b.position);

  return sectionOrder.flatMap((section) =>
    ranked.filter((candidate) => candidate.row.section === section).map(({ row }) => row)
  );
}

/**
 * How well a row answers `needle`: 0 exact, 1 prefix, 2 contained, `null` for no
 * match. An empty query matches everything at one tier, which leaves the roster
 * in its own order — the list a bare `@` should open with.
 */
function matchTier(row: MentionRow, needle: string): number | null {
  if (needle === '') return 0;
  // Both the handle somebody types and the name they read are searchable: `@mio`
  // should find an agent whose handle is `mio-clicker-pm` AND one whose display
  // name is `Mio Clicker PM`, since a person has no way to know which is which.
  const haystacks = [row.handle?.toLowerCase(), row.label.toLowerCase()].filter(
    (value): value is string => value !== undefined
  );
  let best: number | null = null;
  for (const haystack of haystacks) {
    const tier =
      haystack === needle
        ? 0
        : haystack.startsWith(needle)
          ? 1
          : haystack.includes(needle)
            ? 2
            : null;
    if (tier !== null && (best === null || tier < best)) best = tier;
  }
  return best;
}

/**
 * The index of the first selectable row at or after `start`, scanning in
 * `direction` and wrapping.
 *
 * Disabled rows render but are never landed on, so the cursor crosses a section
 * boundary and an unaddressable member alike without the caller knowing either
 * exists. Returns 0 when every row is disabled, which pairs with
 * `hasSelectableRows` being false — nothing will be inserted from that state.
 *
 * @param rows - The rows on screen.
 * @param start - Where to begin, possibly out of range.
 * @param direction - `1` to scan forward, `-1` to scan back.
 */
export function findSelectableIndex(
  rows: readonly MentionRow[],
  start: number,
  direction: 1 | -1
): number {
  const n = rows.length;
  if (n === 0) return 0;
  let index = ((start % n) + n) % n;
  for (let step = 0; step < n; step++) {
    if (!rows[index]?.disabled) return index;
    index = (index + direction + n) % n;
  }
  return 0;
}

/** Where an insert left the text, and where the caret belongs in it. */
export interface MentionInsert {
  value: string;
  cursorPos: number;
}

/**
 * Write `@handle ` over the trigger the person typed.
 *
 * The tail after the caret survives, and the single separating space is not
 * doubled when the tail already starts with one — the same contract the command
 * and file pickers keep, so all three feel like one mechanism.
 *
 * @param text - The whole composer value.
 * @param triggerPos - Index of the `@` that opened the picker.
 * @param query - What had been typed after it.
 * @param handle - The handle to write.
 */
export function insertMention(
  text: string,
  triggerPos: number,
  query: string,
  handle: string
): MentionInsert {
  const before = text.slice(0, triggerPos);
  // +1 for the `@` itself: [triggerPos, triggerPos + 1 + query.length) is the
  // run the picker consumed, and everything past it is the tail.
  const after = text.slice(triggerPos + 1 + query.length);
  const mention = `@${handle}`;
  const separator = after.startsWith(' ') ? '' : ' ';
  return {
    value: before + mention + separator + after,
    // Always PAST the separating space, whether this call supplied it or the
    // tail already had one — there is exactly one either way. Landing the caret
    // before an existing space instead means the next character typed lands
    // against the handle (`@anaand then…`), which is the shape of a bug that
    // only ever shows up when a mention is inserted mid-sentence.
    cursorPos: before.length + mention.length + 1,
  };
}
