'use client';

import { useSearchParams } from 'next/navigation';

/**
 * Returns true when the page is in presentation mode (?present=true).
 * Used by PresentationShell to activate full-screen snap navigation.
 */
export function usePresentationMode(): boolean {
  const params = useSearchParams();
  return params.get('present') === 'true';
}
