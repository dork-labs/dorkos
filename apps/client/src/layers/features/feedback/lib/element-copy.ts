/**
 * The words the feedback form uses for an element someone pointed at: its
 * caption, the question the message box asks about it, and its remove button's
 * name. Kept together so the three never disagree about what it is called.
 *
 * Words printed on the element read as a quote ("Set up a daily run"); a code
 * name turned into words reads as a noun ("the message list").
 *
 * @module features/feedback/lib/element-copy
 */
import type { ElementName } from './element-identity';

/** What an element with no name of its own is called in its caption. */
export const UNNAMED_ELEMENT = 'This part';

/**
 * The caption under the element's thumbnail.
 *
 * @param name - What {@link import('./element-identity').nameElement} found, if anything.
 */
export function elementCaption(name: ElementName | null): string {
  return name?.text ?? UNNAMED_ELEMENT;
}

/**
 * The question the message box asks once something has been pointed at.
 *
 * @param name - What the element is called, if anything.
 */
export function placeholderForElement(name: ElementName | null): string {
  if (!name) return 'What’s wrong with this part?';
  return name.onScreen
    ? `What’s wrong with “${name.text}”?`
    : `What’s wrong with the ${name.text.toLowerCase()}?`;
}

/**
 * The accessible name of the element thumbnail's remove button.
 *
 * @param name - What the element is called, if anything.
 */
export function removeElementLabel(name: ElementName | null): string {
  if (name?.onScreen) return `Remove “${name.text}”`;
  return `Remove ${elementCaption(name).toLowerCase()}`;
}
