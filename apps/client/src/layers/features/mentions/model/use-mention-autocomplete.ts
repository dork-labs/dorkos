/**
 * The `@` mention picker's state: trigger detection, one merged row list, and
 * one selection cursor that crosses section boundaries.
 *
 * @module features/mentions/model/use-mention-autocomplete
 */
import { useState, useMemo, useCallback, useRef } from 'react';
import type { AuthorRef } from '@/layers/entities/room';
import {
  buildMentionRows,
  filterMentionRows,
  findSelectableIndex,
  insertMention,
  ROOM_SECTION_ORDER,
  type MentionInsert,
  type MentionRow,
  type MentionSection,
} from '../lib/mention-rows';
import { useLatest } from '@/layers/shared/lib';

/**
 * An `@` that opens the picker: at the start of the text or after whitespace,
 * then the characters a handle may contain.
 *
 * The leading `(^|\s)` is what keeps `dorian@dorkos.ai` from opening a picker
 * mid-address, and it is why an email or a price never triggers one. The query
 * may be empty, so a bare `@` opens on the whole roster.
 */
const MENTION_TRIGGER = /(^|\s)@([A-Za-z0-9_.-]*)$/;

/** The listbox `id` the composer's `aria-controls` points at when open. */
export const MENTION_LISTBOX_ID = 'mention-palette-listbox';

/** The `id` of the row at `index` — the composer's `aria-activedescendant`. */
export function mentionRowId(index: number): string {
  return `mention-item-${index}`;
}

interface UseMentionAutocompleteOptions {
  /** The room's roster, in the server's own order. */
  members: readonly { author: AuthorRef }[];
  /** Which member is reading, so their own row is not offered. */
  viewerAuthorId: string;
  /** The composer's current text. */
  text: string;
  /** Which section leads. Defaults to a room's People-then-Agents order. */
  sectionOrder?: readonly MentionSection[];
}

interface UseMentionAutocompleteReturn {
  /** Whether a panel is on screen — including the "no match" one. */
  isOpen: boolean;
  /**
   * Whether there is a row Enter may be taken away from the send path for.
   * False for the "No one by that name." panel and for a list whose every row
   * is disabled, so Enter reaches the send instead of being swallowed.
   */
  hasSelectableRows: boolean;
  /** The rows to draw, flat and already in section order. */
  rows: MentionRow[];
  /** Index into {@link UseMentionAutocompleteReturn.rows}. The only cursor. */
  selectedIndex: number;
  /** `aria-activedescendant`, or `undefined` when nothing is highlighted. */
  activeDescendantId: string | undefined;
  /** `aria-controls`, or `undefined` when no panel is up. */
  listboxId: string | undefined;
  /**
   * Record that the text changed. Call from the composer's `onChange`.
   *
   * Deliberately does NOT detect. A composer reports a change and the true
   * caret as two calls in one event, and `onChange` carries only the value —
   * the caret it would have to guess at is the end of the field, which is wrong
   * for every edit made anywhere but the end. Detection belongs to
   * {@link UseMentionAutocompleteReturn.handleCursorChange}, which follows this
   * immediately and knows where the caret actually is.
   */
  noteTextChange: (value: string) => void;
  /** Run trigger detection at `cursorPos`. Call from the composer's `onCursorChange`. */
  handleCursorChange: (cursorPos: number) => void;
  moveDown: () => void;
  moveUp: () => void;
  /** Insert the highlighted row, or return `null` when there is nothing to. */
  selectHighlighted: () => MentionInsert | null;
  /** Insert a specific row — what a click on it does. */
  selectRow: (row: MentionRow) => MentionInsert | null;
  dismiss: () => void;
}

/**
 * Drive an `@` mention picker over a room's roster.
 *
 * The hook owns no text. It reports what to draw and returns the rewritten
 * value on selection, leaving the caller to put it wherever its draft lives —
 * which for a room is a store shared with every other surface, not component
 * state.
 *
 * @param options - Roster, reader, current text, and section order.
 */
export function useMentionAutocomplete({
  members,
  viewerAuthorId,
  text,
  sectionOrder = ROOM_SECTION_ORDER,
}: UseMentionAutocompleteOptions): UseMentionAutocompleteReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [triggerPos, setTriggerPos] = useState(-1);

  // The composer reports a change and a caret move as two calls in one event:
  // `onChange` first with the new text, then `onCursorChange` with the true
  // caret. Between them the `text` prop is a render behind, so the caret call
  // would re-detect against the PREVIOUS text and reopen — or fail to open —
  // the picker on a stale string. Typing an `@` anywhere but the very end is
  // enough to see it. The held value is what both calls read, so both are
  // current.
  const latestText = useLatest(text);

  /**
   * The picker was closed on purpose and must stay closed until something the
   * person did says otherwise.
   *
   * Without it, Escape does not work at all. React synthesises `onSelect` for a
   * textarea off `keydown`/`keyup` among others, so the very Escape that closes
   * the panel is followed by a caret report over unchanged text — which
   * re-detects the same trigger and reopens it in the same tick. A caret move
   * carries no new intent, so it may open a picker but never RE-open a dismissed
   * one; typing (or picking a row) is what clears this.
   */
  const suppressedRef = useRef(false);

  const allRows = useMemo(
    () => buildMentionRows(members, viewerAuthorId),
    [members, viewerAuthorId]
  );

  const rows = useMemo(
    () => (isOpen ? filterMentionRows(allRows, query, sectionOrder) : []),
    [allRows, query, isOpen, sectionOrder]
  );

  // Where the arrow keys last put the highlight, stamped with the list it was
  // moved in. A cursor chosen under a different query — or before the panel
  // reopened — belongs to a list that no longer exists, so the derivation below
  // lands on the first row somebody can actually pick instead. Stamped rather
  // than reset from an effect, so the highlight is never a render behind the
  // list it points into.
  const [cursor, setCursor] = useState<{ query: string; open: boolean; index: number } | null>(
    null
  );
  const proposedIndex =
    cursor !== null && cursor.query === query && cursor.open === isOpen
      ? cursor.index
      : findSelectableIndex(rows, 0, 1);

  // Keep the cursor on a row that exists and can be picked. The roster is live —
  // a member removed mid-type shrinks the list under the highlight, and a stale
  // index is exactly how `aria-activedescendant` starts naming a row that Enter
  // no longer inserts.
  const proposedRow = rows[proposedIndex];
  const selectedIndex =
    rows.length === 0 || (proposedRow !== undefined && !proposedRow.disabled)
      ? proposedIndex
      : findSelectableIndex(rows, 0, 1);

  const detect = useCallback((value: string, cursorPos: number) => {
    const match = value.slice(0, cursorPos).match(MENTION_TRIGGER);
    if (!match) {
      setIsOpen(false);
      return;
    }
    setIsOpen(true);
    setQuery(match[2]);
    setTriggerPos((match.index ?? 0) + match[1].length);
  }, []);

  const noteTextChange = useCallback((value: string) => {
    latestText.write(value);
    // Typing is new intent: whatever was dismissed is no longer what is there.
    suppressedRef.current = false;
  }, [latestText]);

  const handleCursorChange = useCallback(
    (cursorPos: number) => {
      if (suppressedRef.current) return;
      detect(latestText.read(), cursorPos);
    },
    [detect, latestText]
  );

  const moveDown = useCallback(() => {
    setCursor({ query, open: isOpen, index: findSelectableIndex(rows, selectedIndex + 1, 1) });
  }, [rows, selectedIndex, query, isOpen]);

  const moveUp = useCallback(() => {
    setCursor({ query, open: isOpen, index: findSelectableIndex(rows, selectedIndex - 1, -1) });
  }, [rows, selectedIndex, query, isOpen]);

  const selectRow = useCallback(
    (row: MentionRow): MentionInsert | null => {
      if (row.disabled || row.handle === undefined) return null;
      // The caller moves the caret to just past the inserted mention, and that
      // move is reported back here. Suppress first, so restoring the caret
      // cannot reopen the panel that was just used.
      suppressedRef.current = true;
      setIsOpen(false);
      return insertMention(latestText.read(), triggerPos, query, row.handle);
    },
    [triggerPos, query, latestText]
  );

  const selectHighlighted = useCallback((): MentionInsert | null => {
    const row = rows[selectedIndex];
    if (!row) {
      setIsOpen(false);
      return null;
    }
    return selectRow(row);
  }, [rows, selectedIndex, selectRow]);

  const dismiss = useCallback(() => {
    suppressedRef.current = true;
    setIsOpen(false);
  }, []);

  const hasSelectableRows = rows.some((row) => !row.disabled);

  return {
    isOpen,
    hasSelectableRows,
    rows,
    selectedIndex,
    // Read off the SAME index and the same array the palette renders and Enter
    // reads, so what a screen reader announces and what Enter inserts cannot
    // come apart.
    //
    // `=== false` rather than `!disabled`, because the row may not EXIST: for
    // the one render where a narrowing query has shrunk `rows` but the clamp
    // below has not run yet, `selectedIndex` is out of range and `!undefined`
    // is `true` — which would publish an id for a row that was never drawn, and
    // announce nothing at all.
    activeDescendantId:
      isOpen && rows[selectedIndex]?.disabled === false ? mentionRowId(selectedIndex) : undefined,
    listboxId: isOpen ? MENTION_LISTBOX_ID : undefined,
    noteTextChange,
    handleCursorChange,
    moveDown,
    moveUp,
    selectHighlighted,
    selectRow,
    dismiss,
  };
}
