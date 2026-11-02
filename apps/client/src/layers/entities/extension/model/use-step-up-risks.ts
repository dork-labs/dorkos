/**
 * The loaded mini apps that keep "Confirm it's you" off (DOR-3234, Must 3),
 * and the move that fixes one in an agent's folder.
 *
 * @module entities/extension/model/use-step-up-risks
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { StepUpExtensionRisk } from '@dorkos/shared/step-up';
import { resolveApiBaseUrl } from '@/layers/shared/lib';
import { extensionQueryKeys } from './use-pending-extension-approvals';

/** The query key for the list, under `['extensions']` so every refresh there reaches it. */
const RISKS_KEY = [...extensionQueryKeys.all, 'step-up-risks'] as const;

/** Each loaded mini app that keeps confirming off, and why. */
export function useStepUpRisks() {
  return useQuery<StepUpExtensionRisk[]>({
    queryKey: RISKS_KEY,
    queryFn: async () => {
      const res = await fetch(`${resolveApiBaseUrl()}/extensions/step-up-risks`);
      if (!res.ok) throw new Error(`Couldn’t check mini apps (${res.status})`);
      return ((await res.json()) as { risks: StepUpExtensionRisk[] }).risks;
    },
    staleTime: 10_000,
  });
}

/** Move one mini app out of an agent's folder, into DorkOS's own. */
export function useMoveExtensionOut() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { id: string; name: string }>({
    mutationFn: async ({ id }) => {
      const res = await fetch(`${resolveApiBaseUrl()}/extensions/${id}/move-out`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? 'That didn’t work. Nothing moved.');
      }
    },
    onSuccess: (_data, { name }) => {
      toast.success(`Moved ${name}. Turn it on again to use it.`);
    },
    onError: (err, { name }) => {
      toast.error(`Couldn’t move ${name}.`, { description: err.message });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: extensionQueryKeys.all });
    },
    meta: { suppressErrorToast: true },
  });
}
