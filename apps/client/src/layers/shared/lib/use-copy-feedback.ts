import { useState, useCallback } from 'react';
import { TIMING } from './constants';

/**
 * Copy text to clipboard with timed feedback state.
 *
 * Returns a tuple of `[copied, copy]` — `copied` is `true` for `timeoutMs` after
 * `copy()` is invoked, then reverts to `false`. Useful for "Copied!" UI feedback
 * on copy buttons.
 *
 * @param timeoutMs - Duration in milliseconds to keep `copied` true after a copy. Defaults to `TIMING.COPY_FEEDBACK_MS`.
 * @returns A tuple `[copied, copy]` where `copied` is the current feedback state and `copy` writes a string to the clipboard.
 */
export function useCopyFeedback(timeoutMs: number = TIMING.COPY_FEEDBACK_MS) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), timeoutMs);
    },
    [timeoutMs]
  );

  return [copied, copy] as const;
}
