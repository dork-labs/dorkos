'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * The two ways the stage can end.
 *
 * `bezel` is what the page shipped with: a cream shell that fades up around
 * the chat. `macbook` is the drawn machine that rises from below and takes the
 * chat into its screen. Both are live at once so they can be compared on one
 * page rather than from two screenshots and a memory.
 */
export const STAGE_TREATMENTS = ['macbook', 'bezel'] as const;

/** Which ending the stage plays. */
export type StageTreatment = (typeof STAGE_TREATMENTS)[number];

/** The one being evaluated, so a visitor with no stored choice sees it. */
export const DEFAULT_TREATMENT: StageTreatment = 'macbook';

/** Where the choice survives a reload. */
const STORAGE_KEY = 'dorkos.new.stage-treatment';

/** A link can carry the choice: `/new?stage=bezel`. */
const QUERY_KEY = 'stage';

/** Narrow an unknown string to a treatment, or nothing. */
export function parseTreatment(value: string | null | undefined): StageTreatment | null {
  return STAGE_TREATMENTS.find((treatment) => treatment === value) ?? null;
}

/** Everyone reading the choice in this tab, so a press updates all of them. */
const listeners = new Set<() => void>();

/** Subscribe to the choice changing here or in another tab. */
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** The choice as it stands: the link wins, then the stored one, then the default. */
function readTreatment(): StageTreatment {
  const fromQuery = parseTreatment(new URLSearchParams(window.location.search).get(QUERY_KEY));
  return fromQuery ?? parseTreatment(window.localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_TREATMENT;
}

/** What the server renders, having neither a query string nor a localStorage. */
function readDefault(): StageTreatment {
  return DEFAULT_TREATMENT;
}

/**
 * The stage's treatment, remembered between visits.
 *
 * localStorage is an external store, so it is read through
 * `useSyncExternalStore` rather than copied into state by an effect: the
 * server renders the default, the client swaps in the stored choice as it
 * hydrates, and a press in one place reaches every reader without a render
 * cascade.
 */
export function useStageTreatment(): [StageTreatment, (next: StageTreatment) => void] {
  const treatment = useSyncExternalStore(subscribe, readTreatment, readDefault);

  const choose = useCallback((next: StageTreatment) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    // The query string outranks storage, so a press has to clear it or the
    // link a visitor arrived on would silently override every later choice.
    const url = new URL(window.location.href);
    if (url.searchParams.has(QUERY_KEY)) {
      url.searchParams.delete(QUERY_KEY);
      window.history.replaceState(null, '', url);
    }
    for (const listener of listeners) listener();
  }, []);

  return [treatment, choose];
}
