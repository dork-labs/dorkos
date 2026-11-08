/** A green refusal-only suite proves no native masks at that level. */
import assert from 'node:assert/strict';

export function assertProtectionStarts(counts: Record<string, number>): void {
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions'])
    assert((counts[mode] ?? 0) > 0, `No protected native row started at ${mode}`);
}
