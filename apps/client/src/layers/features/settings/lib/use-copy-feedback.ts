import { useState, useCallback } from 'react';
import { TIMING } from '@/layers/shared/lib';

/** Copy text to clipboard with timed feedback state. */
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
