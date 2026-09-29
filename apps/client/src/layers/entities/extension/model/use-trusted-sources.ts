/**
 * The code sources a person trusts outright (spec `flow-multiproject` §9.3):
 * the list, trusting one ("Yes" on the one-time offer), and stopping.
 *
 * Both writes go to person-only routes. The server's bar is the guarantee that
 * an agent can never trust a source; these hooks are only the app's way of
 * asking.
 *
 * @module entities/extension/model/use-trusted-sources
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  TrustedSource,
  TrustedSourcesResponse,
} from '@dorkos/shared/extension-approval-schemas';
import { resolveApiBaseUrl } from '@/layers/shared/lib';
import { extensionQueryKeys } from './use-pending-extension-approvals';

/** The query key for the trusted list. */
export const trustedSourcesQueryKey = [...extensionQueryKeys.all, 'trusted-sources'] as const;

/** A failed request's own sentence, or the status when it sent none. */
async function failureOf(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return new Error(body.message ?? body.error ?? `The server answered ${res.status}`);
}

/** Send one trusted-source write. */
async function writeTrustedSource(method: 'POST' | 'DELETE', source: string): Promise<void> {
  const res = await fetch(`${resolveApiBaseUrl()}/extensions/trusted-sources`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  if (!res.ok) throw await failureOf(res);
}

/** Every source the person trusts, in the order they trusted them. */
export function useTrustedSources() {
  return useQuery<TrustedSource[]>({
    queryKey: trustedSourcesQueryKey,
    queryFn: async () => {
      const res = await fetch(`${resolveApiBaseUrl()}/extensions/trusted-sources`);
      if (!res.ok) throw await failureOf(res);
      return ((await res.json()) as TrustedSourcesResponse).sources;
    },
    staleTime: 30_000,
  });
}

/** Trust or stop trusting a source, refreshing every extension read after. */
export function useTrustedSourceActions() {
  const queryClient = useQueryClient();
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: extensionQueryKeys.all });
  };

  const trust = useMutation<void, Error, string>({
    mutationFn: (source) => writeTrustedSource('POST', source),
    onSuccess: (_data, source) => {
      toast.success(`Extensions from ${source} will now turn on without asking.`, {
        description: 'You can change this in Settings → Extensions.',
      });
    },
    onError: (err) => {
      toast.error('Couldn’t change that. Try again.', { description: err.message });
    },
    onSettled: settle,
    meta: { suppressErrorToast: true },
  });

  const stop = useMutation<void, Error, string>({
    mutationFn: (source) => writeTrustedSource('DELETE', source),
    onError: (err, source) => {
      toast.error(`Couldn’t stop trusting ${source}. Try again.`, { description: err.message });
    },
    onSettled: settle,
    meta: { suppressErrorToast: true },
  });

  return {
    /** Trust every extension from `source`. */
    trust: trust.mutateAsync,
    /** Stop trusting `source`; what is already on stays on. */
    stop: stop.mutate,
    /** The source whose write is in flight, or null. */
    pendingSource: trust.isPending
      ? (trust.variables ?? null)
      : stop.isPending
        ? (stop.variables ?? null)
        : null,
  };
}
