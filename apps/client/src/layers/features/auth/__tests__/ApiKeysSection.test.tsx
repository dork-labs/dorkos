/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiKeysSection } from '../ui/ApiKeysSection';
import { AuthClientProvider } from '../model/auth-client-context';
import { createFakeAuthClient } from './fake-auth-client';
import type { AuthClient, ApiKeyRecord, CreatedApiKey } from '../model/auth-client';

function renderSection(client: AuthClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthClientProvider client={client}>
        <ApiKeysSection />
      </AuthClientProvider>
    </QueryClientProvider>
  );
}

const KEY: ApiKeyRecord = {
  id: 'k1',
  name: 'laptop',
  start: 'dork_ab',
  prefix: 'dork',
  createdAt: '2026-07-01T00:00:00Z',
  expiresAt: null,
  enabled: true,
};

describe('ApiKeysSection', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('creates a key and reveals the secret exactly once', async () => {
    const user = userEvent.setup();
    const created: CreatedApiKey = { ...KEY, key: 'dork_mcp_secret_value' };
    const apiKeyCreate = vi.fn().mockResolvedValue({ data: created, error: null });
    const apiKeyList = vi
      .fn()
      .mockResolvedValueOnce({ data: { apiKeys: [], total: 0 }, error: null })
      .mockResolvedValue({ data: { apiKeys: [KEY], total: 1 }, error: null });
    renderSection(createFakeAuthClient({ apiKeyCreate, apiKeyList }));

    await user.type(screen.getByLabelText('Name'), 'ci-key');
    await user.click(screen.getByRole('button', { name: /create key/i }));

    expect(apiKeyCreate).toHaveBeenCalledWith({ name: 'ci-key', expiresIn: null });

    // The plaintext secret is shown once, with the "won't be shown again" copy.
    expect(await screen.findByText('dork_mcp_secret_value')).toBeInTheDocument();
    expect(screen.getByText(/won’t be shown again/i)).toBeInTheDocument();

    // Dismissing the reveal returns to the create form (secret no longer visible).
    await user.click(screen.getByRole('button', { name: /done/i }));
    expect(screen.queryByText('dork_mcp_secret_value')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /revoke laptop/i })).toBeInTheDocument();
    expect(apiKeyList).toHaveBeenCalledTimes(2);
  });

  it('lists the Better Auth response envelope and revokes its key', async () => {
    const user = userEvent.setup();
    const apiKeyDelete = vi.fn().mockResolvedValue({ data: { success: true }, error: null });
    const apiKeyList = vi
      .fn()
      .mockResolvedValueOnce({ data: { apiKeys: [KEY], total: 1 }, error: null })
      .mockResolvedValue({ data: { apiKeys: [], total: 0 }, error: null });
    renderSection(createFakeAuthClient({ apiKeyList, apiKeyDelete }));

    await user.click(await screen.findByRole('button', { name: /revoke laptop/i }));
    // Confirmation dialog → confirm.
    await user.click(await screen.findByRole('button', { name: /^revoke$/i }));

    await waitFor(() => {
      expect(apiKeyDelete).toHaveBeenCalledWith({ keyId: 'k1' });
    });
    expect(await screen.findByText('No API keys yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke laptop/i })).not.toBeInTheDocument();
    expect(apiKeyList).toHaveBeenCalledTimes(2);
  });

  it('retries a failed list instead of claiming the owner has no keys', async () => {
    const user = userEvent.setup();
    const apiKeyList = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'internal detail', status: 500 },
      })
      .mockResolvedValue({ data: { apiKeys: [], total: 0 }, error: null });
    renderSection(createFakeAuthClient({ apiKeyList }));

    expect(await screen.findByText('Couldn’t load API keys')).toBeInTheDocument();
    expect(screen.queryByText('No API keys yet.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No API keys yet.')).toBeInTheDocument();
    expect(apiKeyList).toHaveBeenCalledTimes(2);
  });
});
