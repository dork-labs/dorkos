/**
 * The one agent a mini app may forward the person's comments to (DOR-3325):
 * the read and the one writer behind Settings → Extensions.
 *
 * @module features/extensions/api/forward-agent
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { extensionApiUrl } from '../model/extension-api-url';
import { extensionKeys } from './queries';

/** The agent the person picked, as the server reads it back. */
export interface ForwardAgentChoice {
  /** The agent, or null when none is picked or the picked one is gone. */
  agent: { id: string; name: string } | null;
  /** The id of a picked agent that is gone, so the editor can say so. */
  missingAgentId?: string | null;
}

/** The cache key for one mini app's agent. */
const forwardAgentKey = (id: string) => [...extensionKeys.detail(id), 'forward-agent'] as const;

/**
 * The agent the person picked for one mini app.
 *
 * @param extensionId - The mini app.
 */
export function useForwardAgent(extensionId: string) {
  return useQuery({
    queryKey: forwardAgentKey(extensionId),
    queryFn: async (): Promise<ForwardAgentChoice> => {
      const res = await fetch(extensionApiUrl(`/extensions/${extensionId}/forward-agent`));
      if (!res.ok) throw new Error(`Couldn’t load the agent. The server answered ${res.status}.`);
      return (await res.json()) as ForwardAgentChoice;
    },
  });
}

/**
 * Pick, or clear, the agent one mini app forwards to.
 *
 * @param extensionId - The mini app.
 */
export function useSetForwardAgent(extensionId: string) {
  const queryClient = useQueryClient();
  return useMutation<ForwardAgentChoice, Error, string | null>({
    mutationFn: async (agentId) => {
      const res = await fetch(extensionApiUrl(`/extensions/${extensionId}/forward-agent`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? 'Couldn’t save the agent. Try again.');
      }
      return (await res.json()) as ForwardAgentChoice;
    },
    onSuccess: (choice) => {
      queryClient.setQueryData(forwardAgentKey(extensionId), choice);
    },
  });
}
