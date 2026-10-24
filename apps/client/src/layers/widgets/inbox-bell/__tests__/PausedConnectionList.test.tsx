/**
 * A connection paused after the DOR-3271 update has its own Needs you row
 * (designer spec `adapter-confirm`): what it sends and where, in ASCII, what it
 * dropped, and one Confirm that sends back exactly what was shown.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { PausedConnectionItem } from '@/layers/entities/attention';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from 'sonner';
import { TransportProvider } from '@/layers/shared/model';
import { PausedConnectionList } from '../ui/PausedConnectionList';

const DEPLOY: PausedConnectionItem = {
  id: 'wh',
  name: 'Deploy hooks',
  kind: 'Webhook',
  confirmation: {
    references: [{ field: 'outbound.headers.Authorization', ref: 'env:DEPLOY_TOKEN' }],
    host: 'xn--hks-ted.example.dev',
    fingerprint: 'fp-1',
    notSent: 1,
  },
};

function renderList(items: PausedConnectionItem[]) {
  const transport = createMockTransport({
    confirmRelayAdapterReferences: vi.fn().mockResolvedValue({ ok: true }),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TransportProvider transport={transport}>
        <PausedConnectionList items={items} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

afterEach(cleanup);

describe('PausedConnectionList', () => {
  it('shows nothing when no connection is paused', () => {
    renderList([]);
    expect(screen.queryByText(/is paused/)).not.toBeInTheDocument();
  });

  it('says what it sends and where (ASCII host), what it dropped, and confirms exactly that', async () => {
    const user = userEvent.setup();
    const transport = renderList([DEPLOY]);

    expect(screen.getByText('Deploy hooks is paused')).toBeInTheDocument();
    expect(screen.getByText('Paused · confirm the setting it sends.')).toBeInTheDocument();
    expect(
      screen.getByText('Webhook · env:DEPLOY_TOKEN → xn--hks-ted.example.dev')
    ).toBeInTheDocument();
    expect(screen.getByText('1 message not sent while paused')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Lets it send DEPLOY_TOKEN to xn--hks-ted.example.dev again. Nothing else changes.'
      )
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm this setting' }));
    await waitFor(() =>
      expect(transport.confirmRelayAdapterReferences).toHaveBeenCalledWith('wh', 'fp-1')
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Deploy hooks is sending again.',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
      )
    );
  });
});
