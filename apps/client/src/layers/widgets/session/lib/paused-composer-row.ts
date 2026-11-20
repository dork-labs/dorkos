import type { QueuedMessage } from '@dorkos/shared/schemas';

/**
 * Only this person's window may restore its own safely typed words.
 * A missing server verdict is a refusal, including older server snapshots.
 *
 * @param row - The public queue row, without its private authority marks
 * @param personClientIds - The person windows allowed to fill this composer
 */
export function isPausedComposerRow(
  row: QueuedMessage,
  personClientIds: readonly string[]
): boolean {
  return (
    row.canRestoreToComposer === true &&
    row.enqueuedBy.startsWith('web-') &&
    personClientIds.includes(row.enqueuedBy) &&
    row.fromChats === undefined
  );
}
