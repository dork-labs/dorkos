import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { getPlatform } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useSessionSearch } from './use-session-search';

/**
 * Starting a brand-new conversation, from anywhere.
 *
 * Lives beside {@link useSessionId} because it is the same question one step on
 * — that hook says which conversation is open, this one opens a fresh one — and
 * because both need the identical dual-mode branch. The one thing it is NOT is
 * `setDir`: that resolves a directory's most recent conversation and resumes it,
 * which is what "open this agent" means. A fresh id is the whole difference, and
 * confusing the two is how the command palette ended up with two rows that did
 * the same thing (DOR-928).
 *
 * It is shared because three surfaces offer this — the sidebar's "New session",
 * the chat header's agent chip, and the palette's agent sub-menu — and each had
 * its own copy that navigated directly. In the Obsidian embed there is no router,
 * so those copies threw when pressed, and threw BEFORE the work that follows
 * (closing the palette, recording frecency), leaving the surface stuck open.
 * Carrying the branch in one place is the only way that stays fixed.
 *
 * @returns A callback taking the agent's working directory — the active one when
 *   omitted — that opens a fresh conversation there. Safe in the router-less
 *   embed, where it moves the stores instead of the URL.
 */
export function useStartNewSession(): (dir?: string) => void {
  const platform = getPlatform();
  const navigate = useNavigate();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const setSelectedCwd = useAppStore((s) => s.setSelectedCwd);
  const setStoreSessionId = useAppStore((s) => s.setSessionId);

  return useCallback(
    (dir?: string) => {
      const target = dir ?? selectedCwd ?? undefined;
      if (platform.isEmbedded) {
        // No URL to write. The stores ARE the address here, and the id still has
        // to be minted so the composer has a session to attach to.
        if (target) setSelectedCwd(target);
        setStoreSessionId(crypto.randomUUID());
        return;
      }
      void navigate({ to: '/session', search: { dir: target, session: crypto.randomUUID() } });
    },
    [platform.isEmbedded, navigate, selectedCwd, setSelectedCwd, setStoreSessionId]
  );
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

/**
 * Dual-mode session ID hook.
 *
 * - **Standalone (web):** reads `?session=` from TanStack Router search params.
 *   Setter navigates to `/session?session=<id>` (history push by default; pass
 *   `{ replace: true }` for an in-place URL rewrite).
 * - **Embedded (Obsidian):** reads/writes Zustand store directly (`replace` is a
 *   no-op — there is no browser history to manage).
 *
 * Both stores are subscribed unconditionally to satisfy React's rules of hooks.
 */
export function useSessionId(): [
  string | null,
  (id: string | null, options?: SetSessionIdOptions) => void,
] {
  const platform = getPlatform();

  // Embedded: Zustand store (always subscribed for rules of hooks)
  const storeId = useAppStore((s) => s.sessionId);
  const setStoreId = useAppStore((s) => s.setSessionId);

  // Standalone: TanStack Router search params
  const search = useSessionSearch();
  const navigate = useNavigate();

  // Stable reference — navigate from TanStack Router is already stable.
  const setSessionId = useCallback(
    (id: string | null, options?: SetSessionIdOptions) => {
      navigate({
        to: '/session',
        search: (prev) => ({
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
          prompt: undefined,
          send: undefined,
        }),
        replace: options?.replace,
      });
    },
    [navigate]
  );

  // Embedded setter ignores options (no history to push/replace).
  const setEmbeddedId = useCallback(
    (id: string | null, _options?: SetSessionIdOptions) => setStoreId(id),
    [setStoreId]
  );

  if (platform.isEmbedded) {
    return [storeId, setEmbeddedId];
  }

  return [search.session ?? null, setSessionId];
}
