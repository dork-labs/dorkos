import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';

import { useAppStore } from '@/layers/shared/model';
import { useSessionSearch } from './use-session-search';
import { toSession } from '@/layers/shared/lib';

/** Open a fresh conversation in the chosen directory, preserving an optional seed. */
export function useStartNewSession(): (dir?: string, options?: StartNewSessionOptions) => void {
  const navigate = useNavigate();
  const selectedCwd = useAppStore((s) => s.selectedCwd);

  return useCallback(
    (dir?: string, options?: StartNewSessionOptions) => {
      const target = dir ?? selectedCwd ?? undefined;
      void navigate(toSession({ dir: target, session: crypto.randomUUID(), seed: options?.seed }));
    },
    [navigate, selectedCwd]
  );
}

/** Extras a caller can put on the fresh conversation's address. */
export interface StartNewSessionOptions {
  /**
   * The `?seed=` launch param (BC-48). Background the first turn carries — never
   * text, and never anything the caller has not enumerated in the route schema.
   */
  seed?: 'dorkbot-help';
}

/** Options for the session-id setter. */
export interface SetSessionIdOptions {
  /**
   * When true, REPLACE the current history entry instead of pushing a new one.
   * Used for the create-on-first-message client-UUID → canonical-id rekey so the
   * canonical URL silently supersedes the optimistic one (no extra Back step).
   */
  replace?: boolean;
  /**
   * The session this new one continues from (the `/clear` intent's "linked back"
   * reference, DOR-109). Recorded as client navigation state in the URL — a
   * lightweight link, no DB column. Omit for an unrelated navigation; passing it
   * as `undefined` drops any prior `continuedFrom` so the link never leaks
   * forward onto later navigations.
   */
  continuedFrom?: string;
}

/** Read the session from the URL and navigate when its id changes. */
export function useSessionId(): [
  string | null,
  (id: string | null, options?: SetSessionIdOptions) => void,
] {
  // Standalone: TanStack Router search params
  const search = useSessionSearch();
  const navigate = useNavigate();

  // Stable reference — navigate from TanStack Router is already stable.
  const setSessionId = useCallback(
    (id: string | null, options?: SetSessionIdOptions) => {
      navigate({
        ...toSession((prev) => ({
          ...prev,
          session: id ?? undefined,
          // Set explicitly so a fresh navigation without a link drops any prior
          // `continuedFrom` rather than carrying it forward via `...prev`.
          continuedFrom: options?.continuedFrom,
          // Launch params belong to the session they were aimed at, and this is
          // the setter that changes which session that is — so they are dropped
          // here for the same reason `continuedFrom` is, and one worse
          // consequence. `/clear` calls this with a fresh uuid; a `?prompt=` and
          // `?send=1` that rode `...prev` forward landed on a session that was
          // empty by construction, where they typed and SENT themselves. The
          // hook that consumes them spends them on every outcome now, so this is
          // the second of two independent guards rather than the only one.
          // `seed` (Ask DorkBot) is dropped here for the identical reason: it is
          // background aimed at ONE conversation, and this is the setter that
          // changes which conversation that is.
          prompt: undefined,
          send: undefined,
          seed: undefined,
        })),
        replace: options?.replace,
      });
    },
    [navigate]
  );

  return [search.session ?? null, setSessionId];
}
