import { useEffect } from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { useAppStore, TransportProvider } from '@/layers/shared/model';
import { useDefaultCwd } from '../use-default-cwd';

function ActiveSession() {
  useEffect(() => useAppStore.getState().setSelectedCwd('/actual/session'), []);
  return null;
}
function Shell() {
  useDefaultCwd();
  return <ActiveSession />;
}

describe('default directory startup', () => {
  it('does not overwrite a session selected by a child before the shell effect runs', () => {
    useAppStore.setState({ selectedCwd: null });
    const client = new QueryClient();
    client.setQueryData(['defaultCwd'], { path: '/server/default' });
    render(
      <QueryClientProvider client={client}>
        <TransportProvider transport={createMockTransport()}>
          <Shell />
        </TransportProvider>
      </QueryClientProvider>
    );
    expect(useAppStore.getState().selectedCwd).toBe('/actual/session');
  });
});
