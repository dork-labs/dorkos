/**
 * What the session's message box is called in each of its modes.
 *
 * @module widgets/session/lib/composer-placeholder
 */
/**
 * The composer's label — its `aria-label`, and its visible placeholder whenever
 * the rotating overlay is not covering it.
 *
 * Editing a queued item used to return `''`, so in the one mode where the
 * field's behavior changes — Enter saves instead of sends — it announced
 * nothing at all. It carries the item's text, so no visible placeholder is lost
 * by naming it properly.
 *
 * @param editingIndex - The queued item under edit, or `null`.
 * @param turnOpen - A turn is running or waiting on a person, so Enter queues.
 * @param queueLength - How many messages are queued.
 * @param defaultText - What the box says otherwise.
 */
export function getPlaceholder(
  editingIndex: number | null,
  turnOpen: boolean,
  queueLength: number,
  defaultText: string
): string {
  if (editingIndex !== null) {
    return `Edit queued message ${editingIndex + 1} of ${queueLength}. Press Enter to save`;
  }
  if (turnOpen && queueLength > 0) return `Compose another (${queueLength} queued)`;
  if (turnOpen) return 'Compose next. It sends when ready';
  return defaultText;
}
