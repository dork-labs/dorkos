/**
 * How loud DorkOS may be (`notifications`): read + patch, with optimistic writes.
 *
 * Modelled on `use-composer-prefs.ts` next door, for the same reason: the answer
 * belongs to the person, not to the browser they opened. It also carries the
 * one-time import of the retired `dorkos-enable-notification-sound` key, the
 * same shape `use-promo-dismissals.ts` uses for its own retired key.
 *
 * @module entities/config/model/use-notification-prefs
 */
import { useCallback, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NotificationPrefs } from '@dorkos/shared/config-schema';
import { NOTIFICATION_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import type { ServerConfig } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useConfig } from './use-config';

/**
 * Where the turn-finished chime lived before it was config (retired).
 *
 * Read exactly once per page load and then deleted, so somebody who had turned
 * the chime OFF in a browser does not have it turned back on by the new
 * default — and so the key never becomes a second source of truth.
 */
const LEGACY_SOUND_KEY = 'dorkos-enable-notification-sound';

/**
 * Guards the one-time import against the several components that read this hook.
 * The import must run once per load, not once per consumer.
 */
let legacyImportAttempted = false;

/** @internal Exported for testing only — resets the once-per-load import latch. */
export function resetLegacySoundImportForTests(): void {
  legacyImportAttempted = false;
}

/**
 * What the retired browser key said, or `undefined` if it said nothing readable.
 *
 * `localStorage` can throw (Safari private mode, a blocked third-party context),
 * and the value is whatever a previous version wrote — `'true'` / `'false'` from
 * the app store's boolean writer.
 */
function readLegacySoundPreference(): boolean | undefined {
  try {
    const stored = localStorage.getItem(LEGACY_SOUND_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    return undefined;
  } catch {
    return undefined;
  }
}

/** A partial patch of {@link NotificationPrefs}, nested exactly as config is. */
export interface NotificationPrefsPatch {
  escalation?: Partial<NotificationPrefs['escalation']>;
  sounds?: Partial<NotificationPrefs['sounds']>;
  notifyOnTurnCompleteWhileAway?: boolean;
  browserPermissionPrimerDismissed?: boolean;
}

/** Apply a patch to a full prefs object, one level of nesting deep. */
function mergePrefs(base: NotificationPrefs, patch: NotificationPrefsPatch): NotificationPrefs {
  return {
    ...base,
    ...(patch.escalation ? { escalation: { ...base.escalation, ...patch.escalation } } : {}),
    ...(patch.sounds ? { sounds: { ...base.sounds, ...patch.sounds } } : {}),
    ...(patch.notifyOnTurnCompleteWhileAway === undefined
      ? {}
      : { notifyOnTurnCompleteWhileAway: patch.notifyOnTurnCompleteWhileAway }),
    ...(patch.browserPermissionPrimerDismissed === undefined
      ? {}
      : { browserPermissionPrimerDismissed: patch.browserPermissionPrimerDismissed }),
  };
}

/** What {@link useNotificationPrefs} hands its consumers. */
export interface NotificationPrefsState {
  /** The person's settings. The shipped defaults until config answers. */
  prefs: NotificationPrefs;
  /** Change one or more of them. Deep-merged server-side. */
  setPrefs: (patch: NotificationPrefsPatch) => void;
  /** Whether a write is in flight. */
  isPending: boolean;
}

/**
 * Read and write how loud DorkOS may be.
 *
 * Answers with {@link NOTIFICATION_PREFS_DEFAULTS} until the config query lands,
 * which is the same rule `useComposerRichText` states: the loading answer tracks
 * the shipped default, so the overwhelmingly common person — who has not touched
 * any of this — never sees a setting swap under them. The cost is bounded and in
 * the right direction: for the one frame before config arrives, somebody who
 * silenced the knock could hear one. Nothing here plays a cue during that frame,
 * because every cue is fired by an ARRIVAL and an arrival needs a loaded list.
 *
 * ## The retired browser key
 *
 * `dorkos-enable-notification-sound` used to hold "play a sound when a turn
 * finishes", on by default. It is now `notifications.sounds.turnEnd`, off by
 * default. The import below runs once per page load, after config has answered,
 * and only when the browser key says something the config does not already: an
 * explicit `true` there means somebody left the chime on and should keep it. An
 * explicit `false` matches the new default, so the key is simply dropped.
 */
export function useNotificationPrefs(): NotificationPrefsState {
  const { data: config } = useConfig();
  const transport = useTransport();
  const queryClient = useQueryClient();

  const prefs = config?.notifications ?? NOTIFICATION_PREFS_DEFAULTS;

  const mutation = useMutation<
    void,
    Error,
    NotificationPrefsPatch,
    { previous: ServerConfig | undefined }
  >({
    mutationFn: (patch) => transport.updateConfig({ notifications: patch }),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: configKeys.current() });
      const previous = queryClient.getQueryData<ServerConfig>(configKeys.current());
      queryClient.setQueryData<ServerConfig>(configKeys.current(), (old) =>
        // Nothing to patch optimistically when the section is not in the cache
        // yet; the settle-time invalidate refetches it.
        old?.notifications ? { ...old, notifications: mergePrefs(old.notifications, patch) } : old
      );
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context && context.previous !== undefined) {
        queryClient.setQueryData(configKeys.current(), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.current() });
    },
  });

  const { mutate } = mutation;
  const setPrefs = useCallback((patch: NotificationPrefsPatch) => mutate(patch), [mutate]);

  // One-time import of the retired browser key. Runs after the first successful
  // read so it can compare rather than clobber, and clears the key only once the
  // server has the answer — clearing on a failed write would lose it for good.
  useEffect(() => {
    if (legacyImportAttempted) return;
    if (config === undefined) return;
    legacyImportAttempted = true;

    const legacy = readLegacySoundPreference();
    if (legacy === undefined) return;

    const dropKey = () => {
      try {
        localStorage.removeItem(LEGACY_SOUND_KEY);
      } catch {
        // A browser that will not let us clear it will not let us read it either
        // on the next load, so there is nothing to recover from here.
      }
    };

    if (legacy === prefs.sounds.turnEnd) {
      // The server already says what the browser said. Nothing to write.
      dropKey();
      return;
    }

    mutate({ sounds: { turnEnd: legacy } }, { onSuccess: dropKey });
  }, [config, prefs.sounds.turnEnd, mutate]);

  return { prefs, setPrefs, isPending: mutation.isPending };
}
