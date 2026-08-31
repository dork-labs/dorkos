/**
 * The control that decides how loud one agent is in one room.
 *
 * **One model, two renderings, and the split is a design decision rather than a
 * fallback.** Above 768px the rungs are a horizontal segmented control, quiet to
 * loud left to right, with the chosen rung's consequence written underneath.
 * Below it they are a vertical list, each rung carrying its own consequence.
 *
 * Two measured reasons, both from the phone:
 *
 * - At 390px — the common iPhone width — the drawer leaves about 318px indented
 *   under the avatar, so four segments get roughly 79px each and `Engaged` and
 *   `Everything` ellipsise. The labels are the ONLY thing telling the rungs
 *   apart, so truncating them removes the meaning rather than the polish. At
 *   320px it collapses outright.
 * - **There is no hover on a touch screen.** The desktop interaction that
 *   teaches the model — move across the rungs and read what each would do —
 *   simply cannot happen there. Showing all four consequences at once is what
 *   replaces it: you read four lines instead of previewing four times.
 *
 * The two renderings share one value, one keyboard model and one test suite;
 * only the layout and where the consequence is printed differ.
 *
 * @module entities/room/ui/ResponseModeControl
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import { cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import {
  RESPONSE_RUNGS,
  explainRung,
  type EngagedWindow,
  type ResponseRung,
} from '../lib/response-mode';

export interface ResponseModeControlProps {
  /** The agent this sets. It names the group, so a screen reader knows whose. */
  memberName: string;
  /**
   * The room the membership lives in. Not the rung count — that is the same
   * four everywhere — but what each rung DOES: the loudest one answers "every
   * message you send here" in a direct message and "every message in this
   * room" in a channel.
   */
  roomKind: RoomKind;
  /**
   * Where the stored value sits on the scale, already projected by `rungOf`.
   *
   * A rung rather than a `responseMode`, because the projection is total and
   * the caller is the one holding the membership: every stored value lands on
   * one of the four, so there is no value that leaves the group without a tab
   * stop or the reader without a selection to see.
   */
  value: ResponseRung;
  /**
   * Commit a rung. Called on click, and on Enter or Space from the keyboard.
   *
   * Never called with the rung already in {@link ResponseModeControlProps.value}
   * — that is not a change, and a caller may treat every call as one.
   */
  onChange: (rung: ResponseRung) => void;
  /**
   * The engaged-window ceilings, or `null` while the config read is in flight.
   * Never the shipped defaults — they are settings, and a guess here puts a
   * false number about somebody's own install on screen.
   */
  engagedWindow: EngagedWindow | null;
  /**
   * Why this control cannot be committed, as the id of the element that says
   * so — or `null` when it can.
   *
   * Non-null makes every rung `aria-disabled` and describes it with that
   * element as well as with its own consequence. Deliberately NOT the `disabled`
   * attribute: a disabled button leaves the tab order, so the reason a screen
   * reader was given would be on a control it can never reach — which is the
   * dead control the reason exists to explain. The rungs stay focusable, still
   * preview what each would do, and simply do not commit.
   */
  disabledReasonId?: string | null;
  /**
   * Which rung the reader is currently contemplating, or `null` when they are
   * contemplating nothing.
   *
   * "Contemplating" is the pointer's hover or the keyboard's aim, whichever
   * moved last — see {@link ResponseModeControl}. Never the rung that is already
   * stored: pointing at the setting you already have is not a hypothetical, and
   * a surface told it was one would dress the status quo up as a change.
   *
   * Called from an effect over derived state rather than from each handler, so
   * it also fires when a commit lands and the thing being contemplated becomes
   * the thing that is true. The identity of the callback is not a dependency, so
   * an inline arrow here is safe.
   */
  onPreview?: (rung: ResponseRung | null) => void;
  className?: string;
}

/**
 * A real radiogroup over this room's rungs.
 *
 * **Arrows move, Enter and Space commit.** That is the manual-selection variant
 * of the pattern rather than the more common selection-follows-focus one, and it
 * is the right one here: every selection is a network write, so arrowing across
 * four rungs would fire three writes nobody asked for. It also buys the
 * interaction the phone cannot have — moving across the rungs rewrites the
 * consequence underneath without changing anything, which is a preview.
 *
 * Every radio is described by the text that states its consequence, so a screen
 * reader gets what the rung DOES and not only what it is called. On the
 * segmented control that is the one line under it, which follows whichever rung
 * the keyboard is on; in the list it is each row's own second line.
 *
 * **Both renderings run quiet to loud, and that is not negotiable.** The list
 * shipped reversed for one release, on the argument that the meter's bars grow
 * upward so louder should be up. The argument is wrong the moment a window is
 * resized: the same four options would physically turn over as the layout
 * crossed 768px, so a reader who learned the order on a laptop would find it
 * inverted on a phone. One control, one direction — first is quietest, wherever
 * it is drawn.
 *
 * **The pointer and the keyboard both point, and the last one to move wins.**
 * Two pieces of state, not one, and the split is the same lesson
 * `AgentChipPicker` paid for: the aim decides the tab stop and pulls DOM focus,
 * so a pointer allowed to write it would drag the cursor around the control on
 * hover. Hover writes its own value instead, a key press clears it, and leaving
 * a rung hands the answer back to wherever the keyboard is. What both feed is
 * one derived rung — the consequence line and {@link ResponseModeControlProps.onPreview}
 * read the same expression, so there is nothing left to disagree.
 */
export function ResponseModeControl({
  memberName,
  roomKind,
  value,
  onChange,
  engagedWindow,
  disabledReasonId = null,
  onPreview,
  className,
}: ResponseModeControlProps) {
  const isMobile = useIsMobile();
  const groupId = useId();
  /**
   * Where the keyboard is, which is not where the value is.
   *
   * `null` means nobody has moved — the tab stop and the explanation both fall
   * back to the selected rung. Cleared when focus leaves the group, so a
   * preview never outlives the reader looking at it.
   */
  const [aimed, setAimed] = useState<ResponseRung | null>(null);
  /**
   * The rung the pointer is over, which is deliberately NOT the aim.
   *
   * Hover must not move the tab stop or pull focus, and the aim does both. Kept
   * apart, hovering can rewrite what is being contemplated without touching
   * where the keyboard is — and a key press clears it, so the two never argue
   * about who is pointing.
   */
  const [hovered, setHovered] = useState<ResponseRung | null>(null);
  const buttons = useRef(new Map<ResponseRung, HTMLButtonElement | null>());

  const focused = aimed ?? value;
  /** What the reader is pointing at, by either means, or nothing. */
  const contemplated = hovered ?? aimed;
  /** Whose consequence is written under the rungs. */
  const shown = contemplated ?? value;

  useEffect(() => {
    // Only ever chases the keyboard. A null aim is the resting state, and
    // focusing on it would drag the page back here every time the reader left.
    if (aimed === null) return;
    buttons.current.get(aimed)?.focus();
  }, [aimed]);

  /**
   * The latest `onPreview`, so reporting can depend on what is being pointed at
   * rather than on the identity of the callback.
   *
   * Callers build this per row, so it is a new function every render; making it
   * a dependency below would fire the report on every render and, for a caller
   * whose handler builds an object, loop.
   */
  const onPreviewRef = useRef(onPreview);
  useEffect(() => {
    onPreviewRef.current = onPreview;
  });

  useEffect(() => {
    // Pointing at what is already stored is not a hypothetical. This is also
    // what clears the preview the moment a commit lands: `value` follows the
    // write, catches up with the rung being pointed at, and the report goes
    // null on its own rather than leaving the outcome dressed as a proposal.
    onPreviewRef.current?.(contemplated === value ? null : contemplated);
  }, [contemplated, value]);

  useEffect(
    // A scale that is put away is not being pointed at. Without this, closing
    // the row mid-hover leaves whatever is reading the preview stuck on a
    // hypothetical about a control that is no longer on screen.
    () => () => onPreviewRef.current?.(null),
    []
  );

  /** Move the aim by `step` through the rungs, wrapping at both ends. */
  function moveAim(step: 1 | -1) {
    const index = RESPONSE_RUNGS.findIndex((option) => option.rung === focused);
    const next = (index + step + RESPONSE_RUNGS.length) % RESPONSE_RUNGS.length;
    setAimed(RESPONSE_RUNGS[next]!.rung);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    // Enter and Space are deliberately absent: these are real buttons, so the
    // browser already turns both into a click, which is the commit.
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        // The keyboard has spoken, so a pointer resting on some other rung
        // stops answering for the reader until it moves again.
        setHovered(null);
        moveAim(1);
        return;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        setHovered(null);
        moveAim(-1);
        return;
      case 'Home':
        event.preventDefault();
        setHovered(null);
        setAimed(RESPONSE_RUNGS[0]!.rung);
        return;
      case 'End':
        event.preventDefault();
        setHovered(null);
        setAimed(RESPONSE_RUNGS[RESPONSE_RUNGS.length - 1]!.rung);
    }
  }

  /**
   * The ids describing one rung: what it does, and — when it cannot be
   * committed — why not. Two ids rather than a replacement, so a reader who
   * cannot change the setting still learns what it means.
   */
  function describedBy(consequenceId: string): string {
    return disabledReasonId === null ? consequenceId : `${consequenceId} ${disabledReasonId}`;
  }

  /**
   * Shared by both renderings: what one rung's button has to be and do.
   *
   * **Known gap, decided explicitly rather than silently left (DOR-1275
   * adversarial review): the mobile rungs below are NOT guarded against the
   * room sheet's drawer-drag-dismiss hazard** the way the loudness pill and
   * the in-row Remove button beside them are (`RoomMemberRow.tsx`'s
   * `useDragVsTapGuard`). They render inside the same scrollable, draggable
   * sheet, and `onClick` here IS a network write — pressing a rung commits it,
   * per {@link ResponseModeControlProps.onChange}'s own contract — so the
   * hazard is real, arguably worse than the pill's (which only opens this
   * panel) or Remove's (which still asks for a confirmation before it takes
   * anyone out).
   *
   * Left unguarded for now rather than extended in a rush: `RESPONSE_RUNGS`
   * renders four buttons off one `.map()`, and `useDragVsTapGuard` needs one
   * instance PER button (a shared instance would let a drag that started on
   * one rung answer for a click on another, the same reasoning
   * `RoomMemberRow.tsx` documents for its own two guards) — which the Rules of
   * Hooks forbid calling inside a loop. Extending it here means either four
   * named hook calls or a small per-key map of press origins, plus a second
   * test pass across both the mobile list and (harmlessly, but not for free)
   * the desktop segmented control that shares this same function. That is
   * real work this pass did not budget for; tracked as a follow-up rather than
   * shipped half-tested.
   */
  function radioProps(rung: ResponseRung) {
    return {
      type: 'button' as const,
      role: 'radio',
      'aria-checked': rung === value,
      'aria-disabled': disabledReasonId === null ? undefined : true,
      // One tab stop for the whole group, on whichever rung the reader would
      // land on — the selected one, or wherever they last arrowed to.
      tabIndex: rung === focused ? 0 : -1,
      ref: (node: HTMLButtonElement | null) => {
        buttons.current.set(rung, node);
      },
      onClick: () => {
        // The pointer names its own target, so the aim follows the click.
        // Without this, clicking one rung after arrowing to another would leave
        // the explanation describing a rung nobody is on. The aim moves even
        // when nothing can be committed, because reading what each rung would
        // do is still worth doing on a room you are deciding whether to revive.
        setAimed(rung);
        if (disabledReasonId !== null) return;
        // Choosing what is already chosen is not a change, and every commit
        // here is a network write. Without this, pressing the checked rung
        // stores a value nothing on screen moves to acknowledge — and where the
        // stored value is an alias, the write silently canonicalises it into
        // something the reader never picked.
        if (rung === value) return;
        onChange(rung);
      },
    };
  }

  const group = {
    role: 'radiogroup',
    'aria-label': `How loud is ${memberName} here?`,
    onKeyDown: handleKeyDown,
    // A reader who tabs away is no longer previewing anything, so the
    // explanation slides back to what is actually set.
    onBlur: (event: React.FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setAimed(null);
    },
  };

  if (isMobile) {
    return (
      <div
        {...group}
        data-slot="response-mode-control"
        className={cn(
          'divide-border border-input divide-y rounded-lg border',
          disabledReasonId !== null && 'opacity-60',
          className
        )}
      >
        {RESPONSE_RUNGS.map((option) => {
          const checked = option.rung === value;
          const consequenceId = `${groupId}-${option.rung}`;
          return (
            <button
              key={option.rung}
              {...radioProps(option.rung)}
              // Named explicitly, because the whole row is the tap target and
              // the consequence line lives INSIDE it. Left to its contents the
              // radio would announce as "Engaged Answers when you @mention it,
              // then keeps answering for 10 more minutes…" — a name and its own
              // description read as one string, which is unusable to arrow
              // through. The name is the visible label, so it still contains
              // what a voice-control user would say.
              aria-label={option.label}
              aria-describedby={describedBy(consequenceId)}
              className={cn(
                'focus-visible:ring-ring flex min-h-12 w-full items-start gap-3 px-3 py-2.5 text-left outline-hidden transition-colors first:rounded-t-lg last:rounded-b-lg focus-visible:ring-2 focus-visible:ring-inset',
                checked ? 'bg-brand/10' : 'active:bg-accent'
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                  checked ? 'border-brand' : 'border-muted-foreground/50'
                )}
              >
                {checked && <span className="bg-brand size-2 rounded-full" />}
              </span>
              <span className="min-w-0">
                <span className={cn('block text-sm font-medium', checked && 'text-brand')}>
                  {option.label}
                </span>
                {/* One line, and the sentence only — the footnote that goes
                    with it is a second thought, and four of them stacked would
                    turn a list you glance at into a page you read. */}
                <span id={consequenceId} className="text-muted-foreground block text-xs">
                  {explainRung(option.rung, roomKind, engagedWindow).sentence}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  const explanation = explainRung(shown, roomKind, engagedWindow);
  const explanationId = `${groupId}-explanation`;
  return (
    <div
      {...group}
      data-slot="response-mode-control"
      className={cn(disabledReasonId !== null && 'opacity-60', className)}
    >
      <div className="border-input flex overflow-hidden rounded-md border">
        {RESPONSE_RUNGS.map((option) => {
          const checked = option.rung === value;
          return (
            <button
              key={option.rung}
              {...radioProps(option.rung)}
              aria-describedby={describedBy(explanationId)}
              // Hover only where hover exists. The phone's list has no pointer
              // to follow — which is why it prints all four consequences at once
              // — and wiring these there would fire a preview on the tap that is
              // already a commit.
              onMouseEnter={() => setHovered(option.rung)}
              onMouseLeave={() => setHovered(null)}
              className={cn(
                'focus-visible:ring-ring h-9 flex-1 border-r px-1 text-xs outline-hidden transition-colors last:border-r-0 focus-visible:ring-2 focus-visible:ring-inset',
                checked
                  ? 'bg-brand/15 text-brand font-medium'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {/* Follows whatever is being POINTED at, not the value: moving across the
          rungs — with the mouse or with the arrow keys — rewrites this without
          committing anything, which is how the model is learned without help
          text. It is also each radio's description, so a screen reader hears the
          consequence as it arrives on the rung. A pointer can rewrite a
          description a focused radio owns, and that is the right trade: the two
          are never in use at the same instant, and the alternative is a panel
          previewing one rung at the top of the sheet and a different one here. */}
      <div id={explanationId} className="mt-2 space-y-1">
        <p className="text-sm">{explanation.sentence}</p>
        {explanation.note !== null && (
          <p className="text-muted-foreground text-xs">{explanation.note}</p>
        )}
      </div>
    </div>
  );
}
