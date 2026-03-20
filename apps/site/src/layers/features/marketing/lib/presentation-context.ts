'use client';

import { createContext, useContext } from 'react';

interface PresentationContextValue {
  isPresent: boolean;
  /**
   * Visible sub-step index for slides that support incremental reveal.
   * 0 = first item only, 1 = first two items, etc.
   * Irrelevant (and always 0) when isPresent is false.
   */
  subStep: number;
}

const PresentationContext = createContext<PresentationContextValue>({
  isPresent: false,
  subStep: 0,
});

export const PresentationProvider = PresentationContext.Provider;

/** Returns presentation mode state and current sub-step for incremental reveal. */
export function usePresentationContext(): PresentationContextValue {
  return useContext(PresentationContext);
}
