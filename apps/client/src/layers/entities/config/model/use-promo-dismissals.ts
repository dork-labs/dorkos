/**
 * Which feature-promo cards this person has waved away, read and written where
 * the answer belongs: their config, not their browser.
 *
 * "I have seen this and I do not want it again" is a fact about the person. It
 * used to live in `localStorage`, so dismissing a card on a laptop left the same
 * card waiting on a phone (spec `sidebar-simplification` D4). It now rides
 * `ui.promos.dismissedIds` through `GET`/`PATCH /api/config`, the same path the
 * upgrade-notification dismissals take.
 *
 * @module entities/config/model/use-promo-dismissals
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import { configKeys } from '../api/query-keys';
import { useConfig } from './use-config';
import { useUpdateConfig } from './use-update-config';

/**
 * Where dismissals lived before they were config (retired).
 *
 * Read exactly once per page load and then deleted, so an install that predates
 * the move keeps its answers without the key becoming a second source of truth
 * that could resurrect a card somebody un-dismissed.
 */
const LEGACY_DISMISSED_KEY = 'dorkos-dismissed-promo-ids';

/**
 * Guards the one-time import against the several components that read this
 * hook — the sidebar's bottom slot and the quiet state on home both mount it,
 * and the import must run once per load, not once per consumer.
 */
let legacyImportAttempted = false;

/**
 * Ids dismissed during THIS page's life, whether or not the write persisted.
 *
 * The server list alone is not enough to hide a card. `updateConfig` is a no-op
 * on the Obsidian `DirectTransport` (`embedded-mode-stubs.ts`), and any
 * transport can answer 200 without the value coming back on the next read. In
 * both cases the optimistic cache write is undone by the refetch and the card
 * the person just dismissed returns — which reads as a broken button.
 *
 * So a dismissal is remembered here too, and {@link usePromoDismissals} reports
 * the union. Module-level rather than component state because several surfaces
 * read this at once (the sidebar's bottom slot and the quiet state on home) and
 * they must agree; `useSyncExternalStore` is what re-renders all of them.
 *
 * This is deliberately NOT a substitute for persistence — it dies with the tab.
 * It is what makes the press honest in the session it happened in.
 */
let sessionDismissed: readonly string[] = [];

/** Subscribers to {@link sessionDismissed}, so every reader re-renders together. */
const sessionListeners = new Set<() => void>();

/** Subscribe to session-local dismissals. */
function subscribeSessionDismissed(onChange: () => void): () => void {
  sessionListeners.add(onChange);
  return () => {
    sessionListeners.delete(onChange);
  };
}

/** Snapshot for `useSyncExternalStore` — a stable reference between changes. */
function readSessionDismissed(): readonly string[] {
  return sessionDismissed;
}

/** Record a dismissal for this session and wake every reader. */
function rememberSessionDismissal(id: string): void {
  if (sessionDismissed.includes(id)) return;
  sessionDismissed = [...sessionDismissed, id];
  for (const listener of sessionListeners) listener();
}

/**
 * Take a dismissal back — the write genuinely failed, so the card returns.
 *
 * Without this the union would swallow the rollback: the cache would be
 * restored, the card would still be hidden, and the person would have no way to
 * reach a promo the server never recorded.
 */
function forgetSessionDismissal(id: string): void {
  if (!sessionDismissed.includes(id)) return;
  sessionDismissed = sessionDismissed.filter((dismissed) => dismissed !== id);
  for (const listener of sessionListeners) listener();
}

/**
 * Reset the once-per-load legacy promo import latch and forget every
 * session-scoped dismissal.
 *
 * @internal Exported for testing only.
 */
export function resetLegacyPromoImportForTests(): void {
  legacyImportAttempted = false;
  sessionDismissed = [];
  for (const listener of sessionListeners) listener();
}

/** Reads the retired browser key, tolerating anything that is not a string list. */
function readLegacyDismissals(): string[] {
  try {
    const stored = localStorage.getItem(LEGACY_DISMISSED_KEY);
    if (stored === null) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/** What {@link usePromoDismissals} hands its consumers. */
export interface PromoDismissals {
  /** Promo ids this person has dismissed. Empty until the config query answers. */
  dismissedIds: string[];
  /** Wave a promo away for good, on every device. Idempotent. */
  dismissPromo: (id: string) => void;
}

/**
 * Read the dismissed promo ids and add to them.
 *
 * The write is optimistic: a card has to leave the moment its `×` is pressed,
 * and a round trip is long enough to read as a dead button. The success
 * invalidation reconciles with the server, and a failed write rolls the cache
 * back rather than leaving a card hidden that was never actually dismissed.
 *
 * What is reported is the UNION of the server's list and
 * {@link sessionDismissed}, so a press holds for the session even where the
 * write cannot persist — read that constant's docs for the two transports where
 * that is the normal case.
 */
export function usePromoDismissals(): PromoDismissals {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();

  const sessionIds = useSyncExternalStore(subscribeSessionDismissed, readSessionDismissed);
  const serverIds = config?.dismissedPromoIds;
  const dismissedIds = useMemo(
    () => [...new Set([...(serverIds ?? []), ...sessionIds])],
    [serverIds, sessionIds]
  );

  // One-time import of the retired browser key. Runs after the first successful
  // read so it can merge rather than clobber, and clears the key only once the
  // server has the ids — clearing on a failed write would lose them for good.
  useEffect(() => {
    if (legacyImportAttempted) return;
    if (config === undefined) return;
    legacyImportAttempted = true;

    const legacy = readLegacyDismissals();
    if (legacy.length === 0) return;

    const merged = [...new Set([...config.dismissedPromoIds, ...legacy])];
    if (merged.length === config.dismissedPromoIds.length) {
      // Everything the browser held is already on the server.
      try {
        localStorage.removeItem(LEGACY_DISMISSED_KEY);
      } catch {}
      return;
    }

    updateConfig.mutate(
      { ui: { promos: { dismissedIds: merged } } },
      {
        onSuccess: () => {
          try {
            localStorage.removeItem(LEGACY_DISMISSED_KEY);
          } catch {}
        },
      }
    );
  }, [config, updateConfig]);

  const dismissPromo = useCallback(
    (id: string) => {
      if (dismissedIds.includes(id)) return;
      const next = [...(serverIds ?? []), id];

      // Held for this session first, so the card goes and STAYS gone even if the
      // write never lands anywhere a later read can see it.
      rememberSessionDismissal(id);

      const previous = queryClient.getQueryData<ServerConfig>(configKeys.current());
      queryClient.setQueryData<ServerConfig>(configKeys.current(), (prev) =>
        prev === undefined ? prev : { ...prev, dismissedPromoIds: next }
      );

      updateConfig.mutate(
        { ui: { promos: { dismissedIds: next } } },
        {
          onError: () => {
            // A genuine failure takes back BOTH, or the union would hide a card
            // the server never recorded and the rollback would be invisible.
            forgetSessionDismissal(id);
            if (previous !== undefined) {
              queryClient.setQueryData<ServerConfig>(configKeys.current(), previous);
            }
          },
        }
      );
    },
    [dismissedIds, serverIds, queryClient, updateConfig]
  );

  return { dismissedIds, dismissPromo };
}
