/**
 * Open the composer's model picker from elsewhere in the chat, as a click on
 * its own trigger, so the picker keeps its focus and keyboard behaviour.
 *
 * @module widgets/session/model/model-trigger
 */

/**
 * Click the model picker's trigger inside this chat panel.
 *
 * @param panel - The chat panel, or null before it mounts.
 */
export function clickModelTrigger(panel: HTMLElement | null): void {
  panel?.querySelector<HTMLButtonElement>('[data-testid="model-config-trigger"]')?.click();
}
