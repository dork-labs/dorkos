/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { KeyEntry } from '../ui/KeyEntry';

afterEach(cleanup);

function renderEntry(status: ConnectorProviderStatus) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={createMockTransport()}>
        <KeyEntry status={status} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

const refusedNango: ConnectorProviderStatus = {
  type: 'nango',
  providerInstanceId: 'cpi_nango' as ConnectorProviderStatus['providerInstanceId'],
  configured: true,
  registered: false,
  custody: 'self-host',
  disclosure: 'Your Nango server keeps your logins on a machine you run.',
  error: 'Set NANGO_ENCRYPTION_KEY on the server, then save the key again.',
};

describe('KeyEntry', () => {
  it('shows the server’s reason when a saved key was refused, before the key box', () => {
    renderEntry(refusedNango);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Set NANGO_ENCRYPTION_KEY on the server, then save the key again.'
    );
    expect(screen.getByTestId('provider-card-nango')).toHaveTextContent(
      'keeps your logins on a machine you run'
    );
    expect(screen.getByLabelText('Nango API key')).toBeInTheDocument();
  });

  it('shows no alert when nothing was refused', () => {
    const { error: _error, ...clean } = refusedNango;
    renderEntry({ ...clean, configured: false });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
