import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { CreateAgentRequestBody } from '@dorkos/shared/mesh-schemas';

/**
 * Mutation hook for creating a new agent via the Transport interface.
 * Invalidates the agents query cache on success.
 */
export function useCreateAgent() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (opts: CreateAgentRequestBody) => transport.createAgent(opts),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agent-paths'] });
      // The Team roster is a second reader of the same fleet, so an agent
      // created from it has to appear on it. A raw literal, like every key
      // above: this is a feature and `entities/team` owns the constant.
      queryClient.invalidateQueries({ queryKey: ['team'] });
    },
    // The shared mutation toast (`query-client.ts`) reports failures — the
    // dialog used to show its own on top of it.
    meta: {
      errorLabel: 'Couldn’t create that agent',
      // A template that brings settings or programs is shown in the dialog,
      // which asks the person whether to create it anyway (DOR-2325). That is a
      // question, not a failure.
      isShownInline: (error: Error) =>
        (error as Error & { body?: { code?: string } }).body?.code === 'template_needs_review',
    },
  });
}
