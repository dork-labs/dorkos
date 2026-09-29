import { useEffect } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';

import { useAppStore, useTransport } from '@/layers/shared/model';
import { useSessionSearch } from './use-session-search';
import { resolveSessionForCwd, notifySessionLookupFailed } from '../../lib/resolve-session-for-cwd';
import { reportClientError, toSession } from '@/layers/shared/lib';
import { beginSessionNavigation } from '../../lib/session-navigation-intent';

/** Options for the directory setter returned by {@link useDirectoryState}. */
export interface SetDirOptions {
  /**
   * Runs once the agent is actually on screen, and not at all if the lookup
   * failed or was overtaken.
   *
   * For the work that must not happen speculatively: the command palette
   * records frecency here, because ranking an agent you never reached is worse
   * than not recording anything (DOR-928).
   */
  onOpened?: () => void;
  /**
   * When true, skip clearing the active session ID on directory change.
   * Use this when you intend to set a new session immediately after switching
   * directories (e.g. navigating to a Tasks run in a different CWD).
   */
  preserveSession?: boolean;
}

/**
 * Dual-mode working-directory hook.
 *
 * - **Standalone (web):** `?dir=` from TanStack Router search params.
 *   A one-way `useEffect` syncs URL → Zustand so store consumers see the
 *   correct CWD. When no `?dir=` is present the getter falls back to Zustand,
 *   which holds the server default CWD set by {@link useDefaultCwd}.
 *
 * Both stores are subscribed unconditionally to satisfy React's rules of hooks.
 */
export function useDirectoryState(): [
  string | null,
  (dir: string | null, opts?: SetDirOptions) => void,
] {
  const storeDir = useAppStore((s) => s.selectedCwd);
  const setStoreDir = useAppStore((s) => s.setSelectedCwd);
  const search = useSessionSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const transport = useTransport();

  const urlDir = search.dir ?? null;

  // Sync URL → Zustand on initial load (standalone only)
  useEffect(() => {
    if (urlDir && urlDir !== storeDir) {
      setStoreDir(urlDir);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentional: one-way sync URL → store on URL change only
  }, [urlDir]);

  return [
    urlDir ?? storeDir,
    (dir, opts) => {
      if (dir) {
        if (opts?.preserveSession) {
          setStoreDir(dir);
          void navigate(toSession((prev) => ({ ...prev, dir })));
          opts?.onOpened?.();
          return;
        }
        const isStillWanted = beginSessionNavigation(() => router.state.location);
        // Always include a session ID so the URL has ?session=; without it the
        // chat input cannot accept text.
        //
        // The store is written AFTER the lookup, not before: the chat stream is
        // keyed on (session id, selected cwd), so committing the new directory
        // while the answer is still out pairs it with the OLD session id and
        // reads the wrong project's transcript.
        // `.catch` at the end, not decoration: `resolveSessionForCwd` handles
        // its own failures, so anything landing here is a defect in this
        // callback — and without it that defect is an unhandled rejection and a
        // click that died in silence.
        void resolveSessionForCwd({ queryClient, transport }, dir)
          .then((resolved) => {
            // Overtaken first: an abandoned switch neither moves you nor
            // explains itself.
            if (!isStillWanted()) return;
            if (resolved === null) {
              notifySessionLookupFailed(dir);
              return;
            }
            setStoreDir(dir);
            void navigate(toSession({ dir, session: resolved.sessionId }));
            opts?.onOpened?.();
          })
          .catch((error: unknown) => {
            reportClientError(transport, error);
            // Same ordering as the success path: an abandoned switch does not
            // explain itself, whatever went wrong. The report above still goes
            // out — a defect is worth knowing about even when the person has
            // moved on; it is only the message TO THEM that would be a lie.
            if (isStillWanted()) notifySessionLookupFailed(dir);
          });
        return;
      }
      void navigate(toSession((prev) => ({ ...prev, dir: undefined })));
    },
  ];
}
