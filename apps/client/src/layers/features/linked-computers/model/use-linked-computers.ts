/**
 * A hub owner's linked computers (step B3, DOR-2946): the list
 * (`GET /api/hub/computers`), minting a one-time link code, and unlinking.
 *
 * The client has no other way to know it is talking to a hub, so the list is
 * the test: a person's own computer answers it with the `/api` 404, which
 * reads as "not a hub" and shows nothing. Never retried, so that 404 costs one
 * request.
 *
 * @module features/linked-computers/model/use-linked-computers
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HubComputerSummary, HubLinkCode } from '@dorkos/shared/session-relay-link';
import { useTransport } from '@/layers/shared/model';

/** TanStack Query key for the hub's linked computers. */
const hubComputersKey = ['hub', 'computers'] as const;

/** What the linked-computers section reads and does. */
export interface LinkedComputers {
  /** Whether this server is a hub whose owner may see the list. */
  isHub: boolean;
  /** The linked computers; empty until loaded. */
  computers: HubComputerSummary[];
  /** The code just minted, until it is dismissed. */
  linkCode: HubLinkCode | null;
  /** The last action's failure, in a sentence; `null` when none. */
  error: string | null;
  /** Whether a code is being minted. */
  minting: boolean;
  /** The computer being unlinked, if any. */
  removing: string | null;
  /** Mint a one-time link code. */
  mint: () => void;
  /** Hide the minted code. */
  dismissCode: () => void;
  /** Unlink a computer. */
  remove: (computerId: string) => void;
}

/** Read and change a hub's linked computers. */
export function useLinkedComputers(): LinkedComputers {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [linkCode, setLinkCode] = useState<HubLinkCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: hubComputersKey,
    queryFn: () => transport.listHubComputers(),
    retry: false,
    staleTime: 15_000,
  });

  const minting = useMutation({
    mutationFn: () => transport.createHubLinkCode(),
    onMutate: () => setError(null),
    onSuccess: (code) => setLinkCode(code),
    onError: () => setError('Couldn’t make a code. Try again.'),
  });

  const removing = useMutation({
    mutationFn: (computerId: string) => transport.removeHubComputer(computerId),
    onMutate: () => setError(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: hubComputersKey }),
    onError: () => setError('Couldn’t remove that computer. Try again.'),
  });

  return {
    isHub: list.isSuccess,
    computers: list.data?.computers ?? [],
    linkCode,
    error,
    minting: minting.isPending,
    removing: removing.isPending ? (removing.variables ?? null) : null,
    mint: () => minting.mutate(),
    dismissCode: () => setLinkCode(null),
    remove: (computerId) => removing.mutate(computerId),
  };
}
