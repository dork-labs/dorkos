/**
 * The agents a mini app may forward the person's comments to (DOR-3325): the
 * read and the one settings writer behind Settings → Extensions.
 *
 * @module features/extensions/api/forward-agents
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { resolveStableClientId } from '@/layers/shared/lib/transport';
import { extensionApiUrl } from '../model/extension-api-url';
import { extensionKeys } from './queries';

/** The agents the person allowed, as the server reads them back. */
export interface ForwardAgentsChoice {
  /** The allowed agents Mesh knows, with their registered names. */
  agents: Array<{ id: string; name: string }>;
  /** Allowed ids Mesh no longer knows, so the editor can offer to remove them. */
  missing: string[];
}

/** The cache key for one mini app's agents. */
const forwardAgentsKey = (id: string) => [...extensionKeys.detail(id), 'forward-agents'] as const;

/**
 * The agents the person allowed for one mini app.
 *
 * @param extensionId - The mini app.
 */
export function useForwardAgents(extensionId: string) {
  return useQuery({
    queryKey: forwardAgentsKey(extensionId),
    queryFn: async (): Promise<ForwardAgentsChoice> => {
      // The window's id: the server reads this list only for the app's own window.
      const res = await fetch(extensionApiUrl(`/extensions/${extensionId}/forward-agents`), {
        headers: { 'X-Client-Id': resolveStableClientId() },
      });
      if (!res.ok) throw new Error(`Couldn’t load the agents. The server answered ${res.status}.`);
      return (await res.json()) as ForwardAgentsChoice;
    },
  });
}

/**
 * Replace the agents one mini app may forward to, by id.
 *
 * @param extensionId - The mini app.
 */
export function useSetForwardAgents(extensionId: string) {
  const queryClient = useQueryClient();
  return useMutation<ForwardAgentsChoice, Error, string[]>({
    mutationFn: async (agentIds) => {
      const res = await fetch(extensionApiUrl(`/extensions/${extensionId}/forward-agents`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': resolveStableClientId() },
        body: JSON.stringify({ agentIds }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? 'Couldn’t save the agents. Try again.');
      }
      return (await res.json()) as ForwardAgentsChoice;
    },
    onSuccess: (choice) => {
      queryClient.setQueryData(forwardAgentsKey(extensionId), choice);
    },
  });
}
