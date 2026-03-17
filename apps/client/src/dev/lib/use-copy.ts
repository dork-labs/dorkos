import { useState, useCallback } from 'react';
import { TIMING } from '@/layers/shared/lib/constants';

/** Clipboard copy with timed feedback state. */
export function useCopy() {
  const [copied, setCopied] = useState(false);

  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), TIMING.COPY_FEEDBACK_MS);
    });
  }, []);

  return { copied, copy };
}
