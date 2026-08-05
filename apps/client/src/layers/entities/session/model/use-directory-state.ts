import { useEffect } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { getPlatform } from '@/layers/shared/lib';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { useSessionSearch } from './use-session-search';
import { useSessionId } from './use-session-id';
import { resolveSessionForCwd, notifySessionLookupFailed } from '../lib/resolve-session-for-cwd';
import { beginSessionNavigation } from '../lib/session-navigation-intent';

/** Options for the directory setter returned by {@link useDirectoryState}. */
export interface SetDirOptions {
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
 * - **Embedded (Obsidian):** Zustand is the sole store; URL is unused.
 *
 * Both stores are subscribed unconditionally to satisfy React's rules of hooks.
 */
export function useDirectoryState(): [
  string | null,
  (dir: string | null, opts?: SetDirOptions) => Promise<boolean>,
] {
  const platform = getPlatform();
  const storeDir = useAppStore((s) => s.selectedCwd);
  const setStoreDir = useAppStore((s) => s.setSelectedCwd);
  const search = useSessionSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const transport = useTransport();
  const [, setSessionId] = useSessionId();

  const urlDir = search.dir ?? null;

  // Sync URL → Zustand on initial load (standalone only)
  useEffect(() => {
    if (!platform.isEmbedded && urlDir && urlDir !== storeDir) {
      setStoreDir(urlDir);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentional: one-way sync URL → store on URL change only
  }, [urlDir]);

  if (platform.isEmbedded) {
    return [
      storeDir,
      (dir, opts) => {
        if (dir) {
          setStoreDir(dir);
          if (!opts?.preserveSession) setSessionId(null);
        }
        return Promise.resolve(true);
      },
    ];
  }

  return [
    urlDir ?? storeDir,
    (dir, opts) => {
      if (dir) {
        if (opts?.preserveSession) {
          setStoreDir(dir);
          void navigate({
            to: '/session',
            search: (prev) => ({ ...prev, dir }),
          });
          return Promise.resolve(true);
        }
        const isStillWanted = beginSessionNavigation(() => router.state.location.href);
        // Always include a session ID so the URL has ?session=; without it the
        // chat input cannot accept text.
        //
        // The store is written AFTER the lookup, not before: the chat stream is
        // keyed on (session id, selected cwd), so committing the new directory
        // while the answer is still out pairs it with the OLD session id and
        // reads the wrong project's transcript.
        return resolveSessionForCwd({ queryClient, transport }, dir).then((resolved) => {
          // Overtaken first: an abandoned switch neither moves you nor explains
          // itself.
          if (!isStillWanted()) return false;
          if (resolved === null) {
            notifySessionLookupFailed(dir);
            return false;
          }
          setStoreDir(dir);
          void navigate({ to: '/session', search: { dir, session: resolved.sessionId } });
          return true;
        });
      }
      void navigate({
        to: '/session',
        search: (prev) => ({ ...prev, dir: undefined }),
      });
      return Promise.resolve(true);
    },
  ];
}
