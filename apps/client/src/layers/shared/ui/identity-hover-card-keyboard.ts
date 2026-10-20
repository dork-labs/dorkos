/**
 * The keyboard's way into an identity card and back out (DOR-3074): Enter or
 * Space on a trigger opens the card and moves focus to its first action,
 * arrows and Tab move between the actions, and Escape closes the card and
 * hands focus back to the trigger.
 *
 * @module shared/ui/identity-hover-card-keyboard
 */
import * as React from 'react';

/** The selector every focusable action in the card answers to. */
const CARD_ACTIONS = '[data-slot="identity-hover-card-actions"] button:not(:disabled)';

/** What {@link useIdentityCardKeyboard} hands the card. */
export interface IdentityCardKeyboard {
  /** Put on the card's content, so focus inside it can be found and kept. */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /**
   * The card's open-change handler, minus one close: a hover card closes when
   * its trigger loses focus, which is exactly what moving into the card does.
   */
  handleOpenChange: (next: boolean) => void;
  /** Spread onto the trigger: Enter and Space open the card and step inside. */
  onTriggerKeyDown: (event: React.KeyboardEvent) => void;
  /** Spread onto the content: Escape returns, leaving focus closes the card. */
  contentHandlers: {
    onEscapeKeyDown: () => void;
    onBlur: (event: React.FocusEvent) => void;
  };
}

/**
 * Give an identity card a keyboard path, for a card whose trigger opens it on a
 * press (an agent's face or name in a room). Radix's hover card keeps its own
 * content out of the tab order, so the steps in and out are made here.
 *
 * @param options.open - Whether the card is open.
 * @param options.setOpen - Opens or closes it, and tells the caller.
 * @param options.triggerRef - The trigger, which focus returns to.
 * @param options.enabled - Whether the trigger opens the card on a press.
 */
export function useIdentityCardKeyboard(options: {
  open: boolean;
  setOpen: (next: boolean) => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
}): IdentityCardKeyboard {
  const { open, setOpen, triggerRef, enabled } = options;
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const stepIn = React.useRef(false);

  // Once the card is drawn, move focus to its first action. It mounts in a
  // portal after `open` flips, so this waits for it a few frames at most.
  React.useEffect(() => {
    if (!open || !stepIn.current) return;
    stepIn.current = false;
    let tries = 0;
    let frame = 0;
    const focusFirst = () => {
      const first = contentRef.current?.querySelector<HTMLButtonElement>(CARD_ACTIONS);
      if (first) return first.focus();
      if (++tries < 10) frame = requestAnimationFrame(focusFirst);
    };
    focusFirst();
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next && contentRef.current?.contains(document.activeElement)) return;
      setOpen(next);
    },
    [setOpen]
  );

  const onTriggerKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (!enabled || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      stepIn.current = true;
      setOpen(true);
    },
    [enabled, setOpen]
  );

  const contentHandlers = React.useMemo(
    () => ({
      // Focus goes back first, so the close that follows is not refused for
      // focus still being inside the card.
      onEscapeKeyDown: () => triggerRef.current?.focus(),
      onBlur: (event: React.FocusEvent) => {
        const next = event.relatedTarget as Node | null;
        if (next && (contentRef.current?.contains(next) || triggerRef.current?.contains(next)))
          return;
        if (contentRef.current?.contains(document.activeElement)) return;
        setOpen(false);
      },
    }),
    [setOpen, triggerRef]
  );

  return { contentRef, handleOpenChange, onTriggerKeyDown, contentHandlers };
}

/**
 * Move between a card's actions with the arrow keys and Tab, wrapping at the
 * ends. Put on each action.
 *
 * @param event - The key pressed on one of the card's actions.
 */
export function moveBetweenCardActions(event: React.KeyboardEvent<HTMLElement>): void {
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
  const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
  const tab = event.key === 'Tab';
  if (!forward && !back && !tab) return;
  const row = event.currentTarget.closest('[data-slot="identity-hover-card-actions"]');
  if (!row) return;
  const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (at === -1 || buttons.length === 0) return;
  event.preventDefault();
  const step = back || (tab && event.shiftKey) ? -1 : 1;
  buttons[(at + step + buttons.length) % buttons.length]!.focus();
}
