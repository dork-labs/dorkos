/**
 * Open the composer's model picker from elsewhere in the chat, as a click on
 * its own trigger, so the picker keeps its focus and keyboard behaviour.
 *
 * @module widgets/session/model/model-trigger
 */
import { useCallback, type RefObject } from 'react';
import { useSessionViewLinks } from '@/layers/features/direct-message';

/** Where the picker's trigger is found inside a chat panel. */
const MODEL_TRIGGER = '[data-testid="model-config-trigger"]';

/** How long to wait for the session view to draw its picker, at most. */
const SESSION_VIEW_WAIT_MS = 3000;

/**
 * Click the model picker's trigger inside this chat panel.
 *
 * @param panel - The chat panel, or null before it mounts.
 */
export function clickModelTrigger(panel: HTMLElement | null): void {
  panel?.querySelector<HTMLButtonElement>(MODEL_TRIGGER)?.click();
}

/**
 * Click the picker's trigger as soon as the panel draws one, giving up after
 * `timeoutMs`. For a picker that is about to appear, not one already there.
 *
 * @param getPanel - Reads the chat panel at each try.
 * @param timeoutMs - How long to keep looking.
 */
export function clickModelTriggerWhenDrawn(
  getPanel: () => HTMLElement | null,
  timeoutMs: number = SESSION_VIEW_WAIT_MS
): void {
  const giveUpAt = Date.now() + timeoutMs;
  const attempt = () => {
    const trigger = getPanel()?.querySelector<HTMLButtonElement>(MODEL_TRIGGER);
    if (trigger) return trigger.click();
    if (Date.now() < giveUpAt) setTimeout(attempt, 50);
  };
  attempt();
}

/**
 * What "Choose model" does in this chat: open the picker.
 *
 * A chat drawn as a DM has no status line, so no picker (DOR-3074). There the
 * press opens the session behind the DM, where the picker lives, and opens the
 * picker once the session view has drawn it.
 *
 * @param panelRef - The chat panel.
 * @param inDirectMessage - Whether the chat is drawn as a DM right now.
 */
export function useChooseModel(
  panelRef: RefObject<HTMLElement | null>,
  inDirectMessage: boolean
): () => void {
  const { openSessionView } = useSessionViewLinks();
  return useCallback(() => {
    if (!inDirectMessage) return clickModelTrigger(panelRef.current);
    openSessionView();
    clickModelTriggerWhenDrawn(() => panelRef.current);
  }, [inDirectMessage, openSessionView, panelRef]);
}
