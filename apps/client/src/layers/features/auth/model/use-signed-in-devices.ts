/**
 * The person's own signed-in devices (F4 part 2, DOR-2969): the list
 * (`GET /api/devices/sessions`), signing one other device out, and signing
 * out everywhere else. Signing out THIS device goes through {@link useSignOut}
 * instead, which also clears the browser's cookie and its cached data.
 *
 * @module features/auth/model/use-signed-in-devices
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SignedInDeviceList } from '@dorkos/shared/signed-in-devices';
import { useTransport } from '@/layers/shared/model';

/** TanStack Query key for the list. */
export const signedInDevicesKey = ['auth', 'signed-in-devices'] as const;

/** What the devices section reads and does. */
export interface SignedInDevices {
  /** The list; `undefined` until loaded. */
  data: SignedInDeviceList | undefined;
  /** Whether the first load is on its way. */
  isLoading: boolean;
  /** Whether loading failed. */
  isError: boolean;
  /** Whether a reload is on its way. */
  isFetching: boolean;
  /** Load again. */
  refetch: () => void;
  /** The id of the device being signed out, or `null`. */
  pendingId: string | null;
  /** Whether "sign out everywhere else" is on its way. */
  signingOutOthers: boolean;
  /** The last sign-out's failure, in a sentence; `null` when none. */
  error: string | null;
  /** Sign out one other device. */
  signOutDevice: (id: string) => void;
  /** Sign out every device but this one. */
  signOutEverywhereElse: () => void;
}

/** The server's own sentence for a refusal, or a plain fallback. */
function sentenceOf(error: unknown): string {
  // A device already gone: the list was stale, and the refetch below fixes it.
  if ((error as { status?: number } | null)?.status === 404) {
    return 'That list was out of date. It’s up to date now.';
  }
  const message = error instanceof Error ? error.message : '';
  return message && !/^HTTP \d+$/.test(message) ? message : 'Couldn’t sign that out. Try again.';
}

/**
 * Read and sign out the person's own signed-in devices.
 *
 * @param enabled - Whether to load the list at all.
 */
export function useSignedInDevices(enabled = true): SignedInDevices {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: signedInDevicesKey,
    queryFn: () => transport.listSignedInDevices(),
    enabled,
    retry: false,
    staleTime: 10_000,
  });

  const signOut = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onMutate: () => setError(null),
    onError: (failure) => setError(sentenceOf(failure)),
    // Always reload: after a sign-out, and after a 404 for a device that had
    // already gone, the list on screen is stale.
    onSettled: () => {
      setPendingId(null);
      void queryClient.invalidateQueries({ queryKey: signedInDevicesKey });
    },
  });

  return {
    data: list.data,
    isLoading: list.isLoading,
    isError: list.isError,
    isFetching: list.isFetching,
    refetch: () => void list.refetch(),
    pendingId,
    signingOutOthers: signOut.isPending && pendingId === null,
    error,
    signOutDevice: (id) => {
      setPendingId(id);
      signOut.mutate(() => transport.signOutDevice(id));
    },
    signOutEverywhereElse: () => signOut.mutate(() => transport.signOutEverywhereElse()),
  };
}
