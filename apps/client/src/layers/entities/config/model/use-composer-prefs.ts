/**
 * Message-box preferences (`ui.composer`, DOR-948): read + mutate with
 * optimistic writes.
 *
 * Modelled on `use-status-bar-prefs.ts`, for the same reasons. The preference
 * lives in server config rather than client `localStorage` so the choice follows
 * the person to every client on this machine and an agent can set it via
 * `config_patch` (spec agents-as-operators). `PATCH /api/config` deep-merges
 * plain objects, so a `{ ui: { composer: { richText } } }` patch touches no
 * other `ui` key. Optimistic cache updates make the switch respond instantly.
 *
 * @module entities/config/model/use-composer-prefs
 */
import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { ComposerPrefs } from '@dorkos/shared/config-schema';
import { COMPOSER_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useConfig } from './use-config';

/** Resolve the composer prefs from a (possibly-undefined) server config. */
function selectComposer(config: ServerConfig | undefined): ComposerPrefs {
  return config?.ui?.composer ?? COMPOSER_PREFS_DEFAULTS;
}

/**
 * Read whether the message box should show formatting as you type
 * (`ui.composer.richText`).
 *
 * Selects from the shared {@link useConfig} query. Schema defaults guarantee the
 * section is present once config loads; until then this answers with
 * {@link COMPOSER_PREFS_DEFAULTS}, which is the SAME value the server would have
 * written for someone who never touched the switch.
 *
 * That is the whole rule, and it is worth stating rather than re-deriving: the
 * loading answer tracks the shipped default, so the overwhelmingly common
 * person — who has not opted out — never sees the field swap under them. It read
 * a hardcoded `false` while the default was `false`, which was the same rule
 * spelled differently; since 2026-08-12 the default is `true`, and a hardcoded
 * `false` would now flash a textarea at everybody for one render. The only
 * people who can still see a swap are those who deliberately turned formatting
 * off, and they see the box they chose arrive a frame late.
 */
export function useComposerRichText(): boolean {
  const { data } = useConfig();
  return selectComposer(data).richText;
}

/** Public shape of {@link useUpdateComposerPrefs}. */
export interface UpdateComposerPrefs {
  /** Turn formatting-as-you-type on or off, and persist it. */
  setRichText: (on: boolean) => void;
  /** Whether a write is in flight. */
  isPending: boolean;
}

/**
 * Persist message-box preference changes with an optimistic cache update.
 *
 * `setRichText(on)` writes the value optimistically into the config query, sends
 * it as `{ ui: { composer: { richText } } }` (deep-merged server-side, so no
 * other `ui` key is touched), rolls back on error, and re-validates by
 * invalidating the config query on settle.
 */
export function useUpdateComposerPrefs(): UpdateComposerPrefs {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const mutation = useMutation<void, Error, boolean, { previous: ServerConfig | undefined }>({
    mutationFn: (richText) => transport.updateConfig({ ui: { composer: { richText } } }),
    onMutate: async (richText) => {
      await queryClient.cancelQueries({ queryKey: configKeys.current() });
      const previous = queryClient.getQueryData<ServerConfig>(configKeys.current());
      queryClient.setQueryData<ServerConfig>(configKeys.current(), (old) =>
        // Replace `ui.composer.richText`, preserving the rest of `ui`. When `ui`
        // is absent from the cache there is nothing to patch optimistically (the
        // settle-time invalidate refetches it), so leave it undefined rather
        // than fabricate a partial `ui`.
        old?.ui ? { ...old, ui: { ...old.ui, composer: { richText } } } : old
      );
      return { previous };
    },
    onError: (_error, _richText, context) => {
      if (context && context.previous !== undefined) {
        queryClient.setQueryData(configKeys.current(), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.current() });
    },
  });

  const setRichText = useCallback((on: boolean) => mutation.mutate(on), [mutation]);

  return { setRichText, isPending: mutation.isPending };
}
