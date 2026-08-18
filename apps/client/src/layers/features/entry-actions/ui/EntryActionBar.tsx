import { Fragment, forwardRef, type KeyboardEvent } from 'react';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { emojiLabel } from '../lib/emoji-catalog';
import { ENTRY_ACTION_ORDER, type EntryAction, type EntryActionSlot } from '../lib/entry-actions';
import { useRovingButtons, type RovingGroupHandle } from '../model/use-roving-buttons';
import { EntryReactionPicker } from './EntryReactionPicker';
import { EntryRunWithMenu, type EntryRunWith } from './EntryRunWithMenu';

/**
 * What the message row can ask the toolbar to do.
 *
 * The same handle the reaction row exposes — a message has two button groups
 * and one way to step into either.
 */
export type EntryActionBarHandle = RovingGroupHandle;

/** The quick-reaction half of the capsule, when this surface offers one. */
export interface EntryActionBarReactions {
  /** This reader's three most-used emoji, most-used first. */
  quick: readonly string[];
  /** Which emoji this reader has already put on this message. */
  mine: readonly string[];
  /** Put one on, or take it back. */
  onToggle: (emoji: string) => void;
  /** True when reacting cannot land right now — a room whose stream has died. */
  disabled?: boolean;
}

interface EntryActionBarProps {
  /** What this message offers, in order. */
  actions: EntryAction[];
  /** The quick row and its picker. Omitted where reactions do not belong. */
  reactions?: EntryActionBarReactions;
  /**
   * What "run this again, elsewhere" would re-run. Omitted where the
   * conversation does not offer it (`capabilities.runWith`).
   */
  runWith?: EntryRunWith;
  /** Hand focus back to the message — the way out, bound to Escape. */
  onExit: () => void;
  /** The toolbar's own look, supplied by the row so anchoring stays with layout. */
  className?: string;
}

/** One button the toolbar draws, in the order it draws them. */
type BarButton =
  | { kind: 'quick'; slot: EntryActionSlot; emoji: string; mine: boolean }
  | { kind: 'picker'; slot: EntryActionSlot }
  | { kind: 'run-with'; slot: EntryActionSlot; runWith: EntryRunWith }
  | { kind: 'command'; slot: EntryActionSlot; action: EntryAction };

/**
 * Every button this capsule holds, in {@link ENTRY_ACTION_ORDER}.
 *
 * Built from the constant rather than by concatenating two lists, so the
 * capsule's order — reactions leftmost, then reply / copy / mention — has one
 * source. A slot with nothing to put in it simply contributes nothing.
 */
function barButtons(
  actions: EntryAction[],
  reactions?: EntryActionBarReactions,
  runWith?: EntryRunWith
): BarButton[] {
  return ENTRY_ACTION_ORDER.flatMap<BarButton>((slot) => {
    if (slot === 'react') {
      if (!reactions) return [];
      return reactions.quick.map((emoji) => ({
        kind: 'quick' as const,
        slot,
        emoji,
        mine: reactions.mine.includes(emoji),
      }));
    }
    if (slot === 'react-more') return reactions ? [{ kind: 'picker' as const, slot }] : [];
    if (slot === 'run-with') return runWith ? [{ kind: 'run-with' as const, slot, runWith }] : [];
    const action = actions.find((candidate) => candidate.id === slot);
    return action ? [{ kind: 'command' as const, slot, action }] : [];
  });
}

/**
 * The action toolbar for one message.
 *
 * Icon-only, because it sits over the message it acts on and words there would
 * cover what you are reading. Each button carries the action's full label as its
 * accessible name and its tooltip, so the name a screen reader speaks and the
 * name a pointer reveals are the same string — the one from the action set,
 * which the right-click menu and the touch drawer also render.
 *
 * **Its leftmost tenants are reactions** (`specs/room-messaging-design` §2):
 * this reader's three most-used emoji, then the button that opens the full
 * picker, then a divider, then the commands. One hover and one click to thank an
 * agent, and the emoji are ordinary buttons in the same roving sequence — so an
 * arrow key reaches them and Enter reacts, exactly as it takes any other action.
 *
 * **Roving tabindex, so a message costs one Tab however many ACTIONS it has.**
 * Every button is `tabIndex={-1}`; the MESSAGE is the tab stop, and the actions
 * are reached from it with an arrow key or Enter, moved between with arrows, and
 * left with Escape. Tab from anywhere in the toolbar goes on to the next message,
 * because there is nothing tabbable in here to catch it. That property is why the
 * quick row could be added at all: three more emoji per message would otherwise
 * have tripled what crossing a room costs. What a message says can still add
 * stops of its own — a link renders as a button — which is the same in session
 * chat and not this surface's to change.
 *
 * The one exception is `run-with`, which keeps the tab stop it has always had —
 * see {@link EntryRunWithMenu}, which explains why taking it away would take the
 * action away from the keyboard entirely on the only surface that offers it.
 *
 * The alternative — making the buttons tabbable only while the row has focus —
 * reads like it would work and does nothing: focusing the row makes its buttons
 * tabbable in the same tick, so the very next Tab lands on the first one anyway
 * and a room of fifty messages still costs a hundred and fifty presses. The tab
 * order has to be closed for the count to change, which is what `-1` is doing.
 */
export const EntryActionBar = forwardRef<EntryActionBarHandle, EntryActionBarProps>(
  function EntryActionBar({ actions, reactions, runWith, onExit, className }, ref) {
    const buttons = barButtons(actions, reactions, runWith);
    const { register, handleKeyDown } = useRovingButtons(buttons.length, onExit, ref);

    if (buttons.length === 0) return null;

    return (
      <div
        role="toolbar"
        aria-label="Message actions"
        aria-orientation="horizontal"
        data-testid="entry-actions"
        className={className}
      >
        {buttons.map((button, index) => {
          const onKeyDown = (event: KeyboardEvent<HTMLElement>) => handleKeyDown(event, index);
          // The divider the design draws between the reactions and the
          // commands, rendered with the first command rather than as a slot of
          // its own — so a capsule with no reactions in it has no stray rule at
          // its left edge.
          const divider =
            button.kind === 'command' && index > 0 && buttons[index - 1]!.kind !== 'command';

          if (button.kind === 'run-with') {
            return (
              <EntryRunWithMenu
                key="run-with"
                prompt={button.runWith.prompt}
                sessionId={button.runWith.sessionId}
                triggerRef={register(index)}
                onTriggerKeyDown={onKeyDown}
              />
            );
          }

          if (button.kind === 'picker') {
            return (
              <EntryReactionPicker
                key="react-more"
                mine={reactions!.mine}
                frequents={reactions!.quick}
                disabled={reactions!.disabled}
                onPick={reactions!.onToggle}
                triggerRef={register(index)}
                onTriggerKeyDown={onKeyDown}
              />
            );
          }

          return (
            <Fragment key={button.kind === 'quick' ? button.emoji : button.action.id}>
              {divider && <span aria-hidden className="bg-border mx-0.5 my-1 w-px self-stretch" />}
              {button.kind === 'quick' ? (
                <Button
                  ref={register(index)}
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  tabIndex={-1}
                  disabled={reactions!.disabled}
                  data-entry-action={button.slot}
                  data-emoji={button.emoji}
                  data-reacted={button.mine ? 'true' : undefined}
                  aria-pressed={button.mine}
                  aria-label={`React with ${emojiLabel(button.emoji)}`}
                  title={`React with ${emojiLabel(button.emoji)}`}
                  onClick={() => reactions!.onToggle(button.emoji)}
                  onKeyDown={onKeyDown}
                  className={cn(
                    'text-[0.8125rem] leading-none',
                    button.mine && 'bg-brand/15 text-foreground'
                  )}
                >
                  <span aria-hidden>{button.emoji}</span>
                </Button>
              ) : (
                <Button
                  ref={register(index)}
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  tabIndex={-1}
                  data-entry-action={button.slot}
                  aria-label={button.action.label}
                  title={button.action.label}
                  onClick={button.action.run}
                  onKeyDown={onKeyDown}
                >
                  <button.action.icon aria-hidden className="size-3.5" />
                </Button>
              )}
            </Fragment>
          );
        })}
      </div>
    );
  }
);
