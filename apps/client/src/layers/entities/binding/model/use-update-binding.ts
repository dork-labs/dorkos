import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { UpdateBindingRequest } from '@dorkos/shared/relay-schemas';
import { BINDINGS_QUERY_KEY } from './use-bindings';

/** Per-surface options for {@link useUpdateBinding}. */
export interface UseUpdateBindingOptions {
  /**
   * Names this surface's action in the shared mutation toast, composed with
   * the server's own sentence. This one mutation backs pause/resume, the edit
   * dialog, and the bridge/un-bridge toggle — each wants its own words, so
   * there is no single generic default; omit only where the caller opts out
   * with {@link suppressErrorToast} instead.
   */
  errorLabel?: string;
  /**
   * Opt out of the shared mutation toast entirely — for a caller with its own
   * conflict handling (a chat that already reaches someone) that must not
   * show a second, contradictory report.
   */
  suppressErrorToast?: boolean;
}

/**
 * Update an existing adapter-agent binding's mutable fields.
 *
 * Accepts exactly the fields the server PATCH endpoint accepts
 * ({@link UpdateBindingRequest}) — including `permissionMode`.
 * Invalidates the bindings cache on success.
 */
export function useUpdateBinding(options: UseUpdateBindingOptions = {}) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: UpdateBindingRequest }) =>
      transport.updateBinding(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...BINDINGS_QUERY_KEY] });
    },
    meta: options.suppressErrorToast
      ? { suppressErrorToast: true }
      : { errorLabel: options.errorLabel ?? "Couldn't update that connection" },
  });
}
