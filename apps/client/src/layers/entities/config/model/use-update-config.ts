import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';

/**
 * Patch the persisted user config.
 *
 * Accepts any partial slice of {@link UserConfig} (e.g.
 * `{ telemetry: { enabled: true, userHasDecided: true } }`). The server
 * deep-merges the patch with the current on-disk config and re-validates the
 * result, so callers don't need to round-trip the full document.
 *
 * Invalidates {@link configKeys.current} on success so any consumer of
 * `useConfig` re-renders with the fresh value.
 */
export function useUpdateConfig() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<void, Error, Record<string, unknown>>({
    mutationFn: (patch) => transport.updateConfig(patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.current() });
    },
  });
}
