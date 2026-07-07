/**
 * Per-user API key hooks — list, create, and revoke scoped Better Auth API keys
 * (the `apiKey` plugin under `/api/auth/api-key/*`). These back the Security
 * section's key management: the plaintext key is returned by `create` exactly
 * once and never retrievable again.
 *
 * @module features/auth/model/use-api-keys
 */
import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthClient } from './auth-client-context';
import type { ApiKeyRecord, AuthError, CreatedApiKey } from './auth-client';

/** TanStack Query key for the current user's API keys. */
export const apiKeysKey = ['auth', 'api-keys'] as const;

/** List the current user's API keys (never includes the secret value). */
export function useApiKeys() {
  const client = useAuthClient();
  return useQuery<ApiKeyRecord[]>({
    queryKey: apiKeysKey,
    queryFn: async () => {
      const { data } = await client.apiKey.list();
      return data ?? [];
    },
    staleTime: 30_000,
  });
}

/** Create a scoped API key. Resolves the created key (with plaintext) or `null` on error. */
export function useCreateApiKey() {
  const client = useAuthClient();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);

  const run = useCallback(
    async (name: string, expiresIn?: number | null): Promise<CreatedApiKey | null> => {
      setIsPending(true);
      setError(null);
      const { data, error: err } = await client.apiKey.create({
        name: name.trim() || undefined,
        expiresIn: expiresIn ?? null,
      });
      setIsPending(false);
      if (err || !data) {
        setError(err ?? { message: 'Failed to create API key.', status: 0 });
        return null;
      }
      await queryClient.invalidateQueries({ queryKey: apiKeysKey });
      return data;
    },
    [client, queryClient]
  );

  return { run, isPending, error, reset: () => setError(null) };
}

/** Revoke (delete) an API key by id. Resolves `true` on success. */
export function useRevokeApiKey() {
  const client = useAuthClient();
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<AuthError | null>(null);

  const run = useCallback(
    async (keyId: string): Promise<boolean> => {
      setPendingId(keyId);
      setError(null);
      const { error: err } = await client.apiKey.delete({ keyId });
      setPendingId(null);
      if (err) {
        setError(err);
        return false;
      }
      await queryClient.invalidateQueries({ queryKey: apiKeysKey });
      return true;
    },
    [client, queryClient]
  );

  return { run, pendingId, error, reset: () => setError(null) };
}
