/**
 * The "Jump back in" popover's state: when it is up, which row is highlighted,
 * and where a row goes (spec `team-room-home` §D2.3).
 *
 * The same shape the `@` picker takes (`features/mentions`) — the hook owns the
 * panel, the composer owns the keyboard, and DOM focus never leaves the text
 * field. That is what lets both palettes ride the composer's shipped palette
 * props without either of them forking it.
 *
 * @module features/jump-back-in/model/use-jump-back-in-popover
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { agentAuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { disambiguateDisplayNames, useResolvedAgents } from '@/layers/entities/agent';
import { mutedRoomIds, useSidebarPrefs } from '@/layers/entities/config';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { roomIdentityMark, type IdentityMark } from '@/layers/entities/room';
import { useJumpBackIn, type JumpBackInItem } from '@/layers/entities/recents';

/**
 * How many threads the popover offers.
 *
 * Fewer than the sidebar's eight, deliberately. The sidebar list is somewhere
 * you look; this one arrives over the page you are already on, so it is a
 * glance — six rows is what stays scannable without becoming a second sidebar
 * floating above the composer.
 */
export const JUMP_BACK_IN_POPOVER_ROWS = 6;

/** The listbox `id` the composer's `aria-controls` points at when open. */
export const JUMP_BACK_IN_LISTBOX_ID = 'jump-back-in-listbox';

/**
 * The `id` of the row at `index` — the composer's `aria-activedescendant`.
 *
 * @param index - Position in the rendered rows.
 */
export function jumpBackInRowId(index: number): string {
  return `jump-back-in-item-${index}`;
}

/**
 * What counts as "the composer" for a focus event.
 *
 * Focus bubbles, so the host hands these handlers to an element that also
 * contains the send button and the clear button — and focusing either of those
 * must not float a panel up. The composer's text field is the one element in
 * that subtree that publishes itself as a `combobox`, which is exactly the
 * contract a palette host relies on anyway: a field that cannot carry
 * `aria-activedescendant` cannot drive this popover at all.
 */
const COMPOSER_FIELD_SELECTOR = '[role="combobox"]';

/**
 * Whether an event target is the composer's own text field.
 *
 * Exported because a second listener needs the same answer: the home surface
 * watches the composer's focus to condense its pinned header while a phone
 * keyboard is up, and it must ignore the send button for exactly the reason
 * this popover does. One definition, so the two can never disagree about what
 * "the composer is focused" means. (Its eventual home is the `Composer` family
 * that publishes the role; it lives here until a second composer feature needs
 * it too.)
 *
 * @param target - The event target to test.
 */
export function isComposerField(target: EventTarget | null): boolean {
  return target instanceof Element && target.matches(COMPOSER_FIELD_SELECTOR);
}

/** Options for {@link useJumpBackInPopover}. */
export interface UseJumpBackInPopoverOptions {
  /** The composer's current text. Anything at all in the box closes the panel. */
  value: string;
  /**
   * Another palette already owns the composer's keyboard — the `@` picker in a
   * room, for one. This popover yields rather than stacking a second listbox
   * over the same field: two panels claiming the same arrow keys is a fight the
   * reader loses. Phase 2 carries this composer into the #team room, where the
   * mention picker is live, which is what this exists for.
   *
   * **What happens when the other palette closes**, since a Phase 2 host has to
   * know: nothing springs back. Reaching the `@` picker means typing, and typing
   * ends the offer for this visit to the box (see the typed latch below), so the
   * panel stays down until the caret leaves and returns. The yield is therefore
   * belt to the latch's braces — it covers the one case the latch cannot, a
   * palette opened over a box that is still empty.
   */
  yieldToPalette?: boolean;
  /**
   * Offer the panel at all — and, just as importantly, READ anything at all.
   *
   * `false` holds every query behind the list idle and keeps the panel shut.
   * The case is the room composer: it is one component mounted in every room
   * and in every thread panel, and only the home surface offers this panel
   * (spec `team-room-home` D2.3). Without this the rest of them each subscribed
   * to the recents fan-out, the room list, the fleet and its manifests, and
   * re-read them on every session lifecycle event — for a panel no gesture in
   * that room could open. Defaults to `true`, so a host that wants the panel
   * says nothing.
   */
  enabled?: boolean;
}

/** What {@link useJumpBackInPopover} answers with. */
export interface UseJumpBackInPopover {
  /** Whether the panel is on screen. */
  isOpen: boolean;
  /** Whether there is a row for Enter to take. The composer's `paletteHasResults`. */
  hasRows: boolean;
  /** The threads to draw, most recently active first. */
  rows: JumpBackInItem[];
  /** Agent manifests keyed by projectPath, for the session rows' faces. */
  agents: Record<string, AgentManifest | null>;
  /** Disambiguated agent display names keyed by projectPath. */
  displayNames: Record<string, string>;
  /**
   * The mark a room row draws — the entity's own derivation, so a direct
   * message wears its agent's face here exactly as it does in the sidebar.
   */
  visualOf: (room: RoomSummary) => IdentityMark;
  /** Index into {@link UseJumpBackInPopover.rows}. The only cursor. */
  selectedIndex: number;
  /** `aria-activedescendant`, or `undefined` when no panel is up. */
  activeDescendantId: string | undefined;
  /** `aria-controls`, or `undefined` when no panel is up. */
  listboxId: string | undefined;
  /** Wire to a focus event over the composer's subtree. */
  handleFocus: (event: { target: EventTarget | null }) => void;
  /** Wire to a blur event over the composer's subtree. */
  handleBlur: (event: { target: EventTarget | null }) => void;
  /**
   * Wire to a pointer-down event over the composer's subtree. Required: on a
   * composer that already holds the caret, this is the ONLY signal a click
   * produces — see {@link UseJumpBackInPopover.handleFocus}'s counterpart.
   */
  handlePointerDown: (event: { target: EventTarget | null }) => void;
  moveDown: () => void;
  moveUp: () => void;
  /** Open the highlighted thread — what Enter does. */
  selectHighlighted: () => void;
  /** Open a specific thread — what a click on a row does. */
  selectRow: (item: JumpBackInItem) => void;
  /** Close without going anywhere — what Escape does. */
  dismiss: () => void;
}

/**
 * Float the last few threads you were in over an empty composer.
 *
 * Opens on a focus the PERSON performed, never on the composer's own
 * mount-time autofocus: arriving on a page is not asking for a panel over it,
 * and a home surface that greets everyone with a floating list is noise on
 * every single load. The two are told apart by when the focus arrives — the
 * composer takes the caret in its own mount effect, which runs before this
 * hook's, so anything that early is the page settling rather than a gesture.
 *
 * Reads {@link useJumpBackIn} with its default cap and shows the first
 * {@link JUMP_BACK_IN_POPOVER_ROWS}, rather than asking for six. The row cap is
 * also the fetch window, so a smaller one would open a SECOND cache entry over
 * the same sessions — two lists, drifting, for a difference of two rows. Muted
 * rooms are dropped for the same reason the sidebar drops them: mute means stop
 * pulling me back into this.
 *
 * @param options - The composer's text, and whether another palette has the keyboard.
 */
export function useJumpBackInPopover({
  value,
  yieldToPalette = false,
  enabled = true,
}: UseJumpBackInPopoverOptions): UseJumpBackInPopover {
  const navigate = useNavigate();
  const sidebarPrefs = useSidebarPrefs();
  const [isFocused, setIsFocused] = useState(false);

  /**
   * The highlight, stamped with the list it was made against.
   *
   * Stored this way rather than reset from an effect: the cursor has to return
   * to the top every time the panel opens and every time the list under it
   * changes shape, and an effect that writes state to achieve that renders
   * twice — once with a highlight pointing past the end of the new list, which
   * is exactly when `aria-activedescendant` names a row Enter no longer opens.
   * A stamp expires by derivation instead, during the render that invalidates
   * it, so there is no such frame.
   */
  const [selection, setSelection] = useState({ stamp: '', index: 0 });

  /**
   * The panel was closed on purpose and stays closed until focus comes back.
   *
   * Escape has to mean something durable here: without this the derived-open
   * rule would put the panel straight back up, since nothing about "focused and
   * empty" changed when the key was pressed.
   */
  const [isDismissed, setIsDismissed] = useState(false);

  /**
   * Something has been typed since the caret arrived, so the offer is over.
   *
   * "Closed while the box has words in it" is not enough on its own: deleting
   * those words back to nothing put the panel straight back up, over a caret
   * somebody was mid-sentence in. Typing is the clearest possible signal that a
   * person came here to write rather than to look at where they have been, and
   * it holds for the rest of this visit to the box. Focusing it again re-offers.
   *
   * Adjusted during render rather than from an effect — React's own answer for
   * state that has to follow a prop. An effect would render once with the panel
   * still up over the first keystroke.
   */
  const [hasTypedSinceFocus, setHasTypedSinceFocus] = useState(false);
  if (value.length > 0 && !hasTypedSinceFocus) setHasTypedSinceFocus(true);

  /**
   * The page has finished arriving.
   *
   * Child effects run before parent effects, so the composer's autofocus — and
   * the focus event it dispatches synchronously — both land while this is still
   * false. Every later focus is a person's.
   */
  const hasSettledRef = useRef(false);
  useEffect(() => {
    hasSettledRef.current = true;
  }, []);

  // Same derivation the sidebar makes, from the same two queries, so this is a
  // cache hit rather than a second fetch of the fleet.
  const { data: meshData } = useMeshAgentPaths({ enabled });
  const agentPaths = useMemo(
    () => (meshData?.agents ?? []).map((agent) => agent.projectPath),
    [meshData]
  );
  const { data: resolvedAgents } = useResolvedAgents(agentPaths, { enabled });
  const agents = useMemo(() => resolvedAgents ?? {}, [resolvedAgents]);
  const displayNames = useMemo(
    () => disambiguateDisplayNames(agentPaths, agents),
    [agentPaths, agents]
  );

  // A participant carries an `agentRef`, not a path; this is the index that
  // turns one back into the other so a direct message can be matched to the
  // fleet and wear the agent's real face.
  const pathByAgentRef = useMemo(
    () => new Map(agentPaths.map((path) => [agentAuthorRef(path), path])),
    [agentPaths]
  );

  const visualOf = useCallback(
    (room: RoomSummary): IdentityMark =>
      roomIdentityMark({ room, agentsByPath: agents, pathByAgentRef }),
    [agents, pathByAgentRef]
  );

  // The reader both surfaces share, from the prefs entity — see `mutedRoomIds`.
  const muted = useMemo(() => mutedRoomIds(sidebarPrefs), [sidebarPrefs]);

  const { items } = useJumpBackIn({ mutedRoomIds: muted, enabled });
  const rows = useMemo(() => items.slice(0, JUMP_BACK_IN_POPOVER_ROWS), [items]);

  // `value.length === 0` as well as the latch, and not redundantly: the latch is
  // raised during the very render that first sees a non-empty box, and this is
  // what keeps the panel down in that same pass rather than in the next one.
  const isOpen =
    // First, and not merely implied by the empty rows a disabled read leaves
    // behind: a host that did not ask for this panel must not be one cache
    // warm-up away from getting one.
    enabled &&
    isFocused &&
    !isDismissed &&
    !hasTypedSinceFocus &&
    !yieldToPalette &&
    value.length === 0 &&
    rows.length > 0;

  // What the highlight is valid against: this opening, over a list of this
  // length. Anything else and the cursor is back at the top.
  const selectionStamp = `${isOpen}:${rows.length}`;
  const selectedIndex = selection.stamp === selectionStamp ? selection.index : 0;

  const handleFocus = useCallback((event: { target: EventTarget | null }) => {
    if (!hasSettledRef.current) return;
    if (!isComposerField(event.target)) return;
    // A fresh arrival is a fresh offer: whatever was typed or dismissed belonged
    // to the last time the caret was in this box.
    setIsDismissed(false);
    setHasTypedSinceFocus(false);
    setIsFocused(true);
  }, []);

  /**
   * The other way a person asks for this panel: pressing on the box.
   *
   * Focus alone cannot carry the gesture. The composer takes the caret on mount,
   * so on the home surface the field is ALREADY focused — clicking it dispatches
   * no focus event at all, and the primary gesture ("click the empty box, see
   * where you left off") did nothing whatsoever. This is the trigger for that
   * case, and the only one that fires on a second click.
   *
   * It opens rather than re-offering: it deliberately clears neither the
   * dismissal nor the typed latch, so Escape and typing both keep meaning "not
   * this time" until the caret leaves and comes back.
   */
  const handlePointerDown = useCallback((event: { target: EventTarget | null }) => {
    if (!isComposerField(event.target)) return;
    setIsFocused(true);
  }, []);

  const handleBlur = useCallback((event: { target: EventTarget | null }) => {
    if (!isComposerField(event.target)) return;
    setIsFocused(false);
  }, []);

  /** Move the highlight by one, wrapping at both ends, and re-stamp it. */
  const moveBy = useCallback(
    (step: 1 | -1) => {
      if (rows.length === 0) return;
      setSelection((prev) => {
        const from = prev.stamp === selectionStamp ? prev.index : 0;
        return { stamp: selectionStamp, index: (from + step + rows.length) % rows.length };
      });
    },
    [rows.length, selectionStamp]
  );

  const moveDown = useCallback(() => moveBy(1), [moveBy]);
  const moveUp = useCallback(() => moveBy(-1), [moveBy]);

  const dismiss = useCallback(() => {
    setIsDismissed(true);
  }, []);

  /**
   * Go where a row points — the same two routes the sidebar's rows use, so a
   * thread opened from here and the same thread opened from there land on one
   * screen with one URL.
   */
  const selectRow = useCallback(
    (item: JumpBackInItem) => {
      setIsDismissed(true);
      // Picking a row here is the same act as clicking one in the sidebar, so
      // it leaves the same record (DOR-1156). The panel answers "where were
      // you?" — a door that did not write one made Today forget the answer the
      // moment the operator acted on it.
      if (item.kind === 'session') {
        useInteractionStore.getState().recordOpened('session', item.session.id);
        if (item.session.cwd) {
          useInteractionStore.getState().recordOpened('agent', item.session.cwd);
        }
        navigate({
          to: '/session',
          search: { dir: item.session.cwd ?? undefined, session: item.session.id },
        });
        return;
      }
      useInteractionStore.getState().recordOpened('room', item.room.id);
      navigate({ to: '/channels', search: { id: item.room.id } });
    },
    [navigate]
  );

  // Nothing on screen, nothing to take: a panel that is down must not answer
  // for a key that was never aimed at it.
  const selectHighlighted = useCallback(() => {
    const row = rows[selectedIndex];
    if (!isOpen || !row) return;
    selectRow(row);
  }, [isOpen, rows, selectedIndex, selectRow]);

  return {
    isOpen,
    hasRows: rows.length > 0,
    rows,
    agents,
    displayNames,
    visualOf,
    selectedIndex,
    // Read off the same index and the same array the panel draws and Enter
    // opens, so what a screen reader announces and where Enter goes cannot come
    // apart. `undefined` while nothing is up, and while the index has outrun a
    // list that shrank under it.
    activeDescendantId:
      isOpen && rows[selectedIndex] !== undefined ? jumpBackInRowId(selectedIndex) : undefined,
    listboxId: isOpen ? JUMP_BACK_IN_LISTBOX_ID : undefined,
    handleFocus,
    handleBlur,
    handlePointerDown,
    moveDown,
    moveUp,
    selectHighlighted,
    selectRow,
    dismiss,
  };
}
