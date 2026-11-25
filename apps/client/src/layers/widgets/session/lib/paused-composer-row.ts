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

/**
 * A restored draft every window may show in its composer (spec
 * `turns-survive-restarts` §7.3): words a turn started with that came back
 * after a restart. Unlike a paused row, any window shows it, not only the one
 * that typed it; another chat's words never fill a person's composer.
 *
 * @param row - The public queue row
 */
export function isRestoredDraftRow(row: QueuedMessage): boolean {
  return row.restored === true && row.canRestoreToComposer === true && row.fromChats === undefined;
}
