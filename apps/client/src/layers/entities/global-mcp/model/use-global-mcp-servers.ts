import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GlobalMcpServerInput, GlobalMcpServerPatch } from '@dorkos/shared/global-mcp-schemas';
import { useTransport } from '@/layers/shared/model';

/** The one list of global MCP servers. */
export const GLOBAL_MCP_KEY = ['global-mcp-servers'] as const;

/**
 * What every change here shares. DorkOS runs on this computer, so `navigator.onLine` says nothing
 * about reaching it, and TanStack's default would pause a change on dropped Wi-Fi. Refusals show
 * inline, where the change was asked for, with no toast on top.
 */
const CHANGE_OPTIONS = {
  networkMode: 'always',
  meta: { suppressErrorToast: true },
} as const;

/** Every server a person added for every agent. */
export function useGlobalMcpServers() {
  const transport = useTransport();
  return useQuery({
    queryKey: GLOBAL_MCP_KEY,
    queryFn: async () => (await transport.listGlobalMcpServers()).servers,
    networkMode: 'always',
  });
}

/** Refetch the list when a change ends, however it ended: a failed remove can still remove. */
function useRefreshOnSettled() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: GLOBAL_MCP_KEY });
}

/**
 * Ask whether typed arguments look like a secret. They may be one, so they get the same care as
 * Add's input: nothing cached past the answer. A failed check just means no warning.
 */
export function useCheckGlobalMcpArgs() {
  const transport = useTransport();
  return useMutation({
    ...CHANGE_OPTIONS,
    gcTime: 0,
    mutationFn: (args: readonly string[]) => transport.checkGlobalMcpArgs(args),
  });
}

/**
 * Add a server for every agent. Waits on "Confirm it's you" when the server holds it. Its input
 * holds typed secrets, so the cache keeps none of it past the form: `gcTime: 0` drops each press
 * as soon as nothing is watching it.
 */
export function useAddGlobalMcpServer() {
  const transport = useTransport();
  const onSettled = useRefreshOnSettled();
  return useMutation({
    ...CHANGE_OPTIONS,
    gcTime: 0,
    mutationFn: (input: GlobalMcpServerInput) => transport.addGlobalMcpServer(input),
    onSettled,
  });
}

/** Turn a server on or off, or change who gets it. Waits on "Confirm it's you" when held. */
export function usePatchGlobalMcpServer() {
  const transport = useTransport();
  const onSettled = useRefreshOnSettled();
  return useMutation({
    ...CHANGE_OPTIONS,
    mutationFn: ({ name, patch }: { name: string; patch: GlobalMcpServerPatch }) =>
      transport.patchGlobalMcpServer(name, patch),
    onSettled,
  });
}

/** Remove a server and its saved secrets. */
export function useRemoveGlobalMcpServer() {
  const transport = useTransport();
  const onSettled = useRefreshOnSettled();
  return useMutation({
    ...CHANGE_OPTIONS,
    mutationFn: (name: string) => transport.removeGlobalMcpServer(name),
    onSettled,
  });
}
