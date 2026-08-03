import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { BINDINGS_QUERY_KEY } from './use-bindings';

/**
 * Re-point an existing binding at a different agent, keeping its id.
 *
 * One chat reaches one agent, so a second binding for a chat that is already
 * taken is refused rather than created. Moving the binding that already owns
 * the chat is the only way to change who answers it, which is what the
 * "This chat reaches X. Move it to Y?" dialog calls.
 */
export function useMoveBinding() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, agentId }: { id: string; agentId: string }) =>
      transport.moveBinding(id, agentId),
    meta: { errorLabel: "Couldn't move the chat" },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...BINDINGS_QUERY_KEY] });
    },
  });
}
