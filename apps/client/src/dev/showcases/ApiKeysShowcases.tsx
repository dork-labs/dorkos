import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ApiKeysSection,
  AuthClientProvider,
  type ApiKeyRecord,
  type AuthClient,
} from '@/layers/features/auth';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

const MINUTE = 60_000;

/** Made-up keys: one used remotely a few minutes ago, one days ago, one never. */
function sampleKeys(): ApiKeyRecord[] {
  const now = Date.now();
  const base = { prefix: 'dork_', enabled: true, expiresAt: null };
  return [
    {
      ...base,
      id: 'key-phone',
      name: 'Phone',
      start: 'dork_a1b2',
      createdAt: new Date(now - 30 * 24 * 60 * MINUTE).toISOString(),
      lastUsedRemotelyAt: new Date(now - 5 * MINUTE).toISOString(),
    },
    {
      ...base,
      id: 'key-laptop',
      name: 'Travel laptop',
      start: 'dork_c3d4',
      createdAt: new Date(now - 60 * 24 * 60 * MINUTE).toISOString(),
      expiresAt: new Date(now + 90 * 24 * 60 * MINUTE).toISOString(),
      lastUsedRemotelyAt: new Date(now - 3 * 24 * 60 * MINUTE).toISOString(),
    },
    {
      ...base,
      id: 'key-script',
      name: 'Backup script',
      start: 'dork_e5f6',
      createdAt: new Date(now - 2 * 24 * 60 * MINUTE).toISOString(),
      lastUsedRemotelyAt: null,
    },
  ];
}

/** An auth client that answers only the key list, with the keys above. */
function keysOnlyClient(apiKeys: ApiKeyRecord[]): AuthClient {
  const none = async () => ({ data: null, error: null });
  return {
    signIn: { email: none, social: none },
    signUp: { email: none },
    signOut: async () => ({ data: { success: true }, error: null }),
    getSession: none,
    apiKey: {
      create: none,
      list: async () => ({ data: { apiKeys, total: apiKeys.length }, error: null }),
      delete: async () => ({ data: { success: true }, error: null }),
    },
  };
}

/** The API keys list in Login & security, with the "Last used remotely" line (DOR-4206). */
export function ApiKeysShowcases() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const client = useMemo(() => keysOnlyClient(sampleKeys()), []);
  return (
    <PlaygroundSection
      title="API Keys"
      description="The key list in Login & security. A key used from another device shows when; the exact time shows on hover."
    >
      <ShowcaseLabel>Three keys: used minutes ago, days ago, never</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={queryClient}>
          <AuthClientProvider client={client}>
            <ApiKeysSection />
          </AuthClientProvider>
        </QueryClientProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
