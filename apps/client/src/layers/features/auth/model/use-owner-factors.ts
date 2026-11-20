/**
 * The owner's sign-in checks: passkeys and authenticator apps that prove a
 * sign-in from another device (DOR-3647). Adding or removing one asks
 * "Confirm it's you" first, which the app's fetch handles. With a passkey on
 * this computer, adding an authenticator app or removing a check also takes a
 * fresh passkey check, run here.
 *
 * @module features/auth/model/use-owner-factors
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OwnerFactor, PendingAuthenticator } from '@dorkos/shared/signed-in-devices';
import { useTransport } from '@/layers/shared/model';
import { makePasskey, withPasskeyCheck } from '../lib/passkey-ceremony';

/** TanStack Query key for the list. */
export const ownerFactorsKey = ['auth', 'owner-factors'] as const;

/** What the section reads and does. */
export interface OwnerFactors {
  readonly factors: readonly OwnerFactor[];
  /** Whether a check that works from away was ever set up, as the server counts it. */
  readonly everHadAway: boolean;
  readonly isLoading: boolean;
  /** Whether this caller may not see them (not the owner in person): show nothing. */
  readonly unavailable: boolean;
  /** A new authenticator app waiting for its first code. */
  readonly pending: PendingAuthenticator | null;
  readonly busy: boolean;
  readonly error: string | null;
  addPasskey(): Promise<void>;
  startAuthenticator(): Promise<void>;
  confirmAuthenticator(code: string): Promise<boolean>;
  cancelAuthenticator(): void;
  remove(id: string): Promise<void>;
}

/** A sentence for a failure. */
function sentenceOf(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'The passkey was cancelled. Nothing changed.';
  }
  const message = error instanceof Error ? error.message : '';
  return message && !/^HTTP \d+$/.test(message) ? message : 'That didn’t work. Try again.';
}

/**
 * Read and change the owner's sign-in checks.
 *
 * @param enabled - Whether to load them: only for the owner in person.
 */
export function useOwnerFactors(enabled: boolean): OwnerFactors {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingAuthenticator | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ownerFactorsKey,
    queryFn: () => transport.listOwnerFactors(),
    enabled,
    retry: false,
  });

  const run = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (failure) {
      setError(sentenceOf(failure));
      return undefined;
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ownerFactorsKey });
    }
  };

  return {
    factors: list.data?.factors ?? [],
    everHadAway: list.data?.everHadAway ?? false,
    isLoading: list.isLoading,
    unavailable: list.isError,
    pending,
    busy,
    error,
    addPasskey: async () => {
      await run(async () => {
        const started = await withPasskeyCheck((passkey) =>
          transport.startAddingPasskey('Passkey', passkey)
        );
        if (started.kind !== 'options') return;
        await transport.finishAddingPasskey(await makePasskey(started.options));
      });
    },
    startAuthenticator: async () => {
      const started = await run(() =>
        withPasskeyCheck((passkey) =>
          transport.startAddingAuthenticator('Authenticator app', passkey)
        )
      );
      if (started?.kind === 'started') setPending(started.pending);
    },
    confirmAuthenticator: async (code) => {
      if (!pending) return false;
      const done = await run(() => transport.confirmAuthenticator(pending.id, code));
      if (done) setPending(null);
      return done !== undefined;
    },
    cancelAuthenticator: () => setPending(null),
    remove: async (id) => {
      await run(() => withPasskeyCheck((passkey) => transport.removeOwnerFactor(id, passkey)));
    },
  };
}
