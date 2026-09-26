/**
 * A text draft the person edits, seeded from a value the server owns.
 *
 * @module features/profile/model/use-server-seeded-draft
 */
import { useState } from 'react';

/**
 * A text field the person edits, seeded from a value the server owns.
 *
 * The roster changes under a form — a successful save refetches it, and so
 * does anything else that renames this person — so a draft has to give way once
 * the stored value itself moves, or the form shows a stale edit of a value that
 * has already changed. Per field rather than per form: saving your name must
 * not throw away a handle you were half-way through typing.
 *
 * Adjusted during render rather than in an effect, which is React's own
 * prescription for this ("adjusting state when a prop changes") and avoids the
 * extra render pass an effect would add on every roster refetch.
 *
 * @param serverValue - What the server holds right now.
 * @returns The draft and its setter.
 */
export function useServerSeededDraft(serverValue: string): [string, (next: string) => void] {
  const [draft, setDraft] = useState(serverValue);
  const [seed, setSeed] = useState(serverValue);
  if (seed !== serverValue) {
    setSeed(serverValue);
    setDraft(serverValue);
  }
  return [draft, setDraft];
}
