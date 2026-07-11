/**
 * Pure hunk helpers for the diff-review surface (DOR-212).
 *
 * Kept free of React and of the heavy `@codemirror/view` runtime so the header
 * count and the reject-all content builder are unit-testable without mounting an
 * editor. Chunk detection reuses `@codemirror/merge`'s own line-diff (the same
 * algorithm the visible gutter uses) so the count never disagrees with what the
 * operator sees.
 *
 * @module features/diff-review/lib/hunks
 */
import { Text } from '@codemirror/state';
import { Chunk } from '@codemirror/merge';

/**
 * Count the changed hunks between `baseline` and `current` — the "N changes"
 * shown in the review header. Zero means the file matches its baseline (nothing
 * to review). Uses the same line-diff as the rendered gutter.
 *
 * @param baseline - The pre-edit content (diff "before").
 * @param current - The current on-disk content (diff "after").
 */
export function countChangedChunks(baseline: string, current: string): number {
  if (baseline === current) return 0;
  const a = Text.of(baseline.split('\n'));
  const b = Text.of(current.split('\n'));
  return Chunk.build(a, b).length;
}
