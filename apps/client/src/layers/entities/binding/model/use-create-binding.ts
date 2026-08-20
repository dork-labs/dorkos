import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { CreateBindingRequest } from '@dorkos/shared/relay-schemas';
import { BINDINGS_QUERY_KEY } from './use-bindings';

/** Per-surface options for {@link useCreateBinding}. */
export interface UseCreateBindingOptions {
  /**
   * Names this surface's action in the shared mutation toast, composed with
   * the server's own sentence. Defaults to a generic line covering the
   * ordinary picker flows; a caller with its own conflict handling (a chat
   * that already reaches someone) opts out with {@link suppressErrorToast}
   * instead.
   */
  errorLabel?: string;
  /**
   * Opt out of the shared mutation toast entirely — for a caller that reports
   * failures itself (e.g. distinguishing a chat conflict from an ordinary
   * failure and showing a dialog instead of a toast for the former).
   */
  suppressErrorToast?: boolean;
}

/**
 * Create a new adapter-agent binding.
 * Invalidates the bindings cache on success.
 */
export function useCreateBinding(options: UseCreateBindingOptions = {}) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBindingRequest) => transport.createBinding(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...BINDINGS_QUERY_KEY] });
    },
    meta: options.suppressErrorToast
      ? { suppressErrorToast: true }
      : { errorLabel: options.errorLabel ?? "Couldn't add that connection" },
  });
}
