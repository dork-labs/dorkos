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
import { waitingLabel } from '../ui/InboxBell';

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

describe('the bell with a paused connection waiting', () => {
  it('says "is" for one waiting item and "are" for more', () => {
    expect(waitingLabel(0, 0, 0, 0, 0, 1)).toBe(
      '1 paused connection is waiting on you. Open to answer.'
    );
    expect(waitingLabel(0, 0, 0, 0, 0, 2)).toBe(
      '2 paused connections are waiting on you. Open to answer.'
    );
    expect(waitingLabel(1, 0, 0, 0, 0, 1)).toBe(
      '1 request and 1 paused connection are waiting on you. Open to answer.'
    );
  });
});

describe('PausedConnectionList', () => {
  // DOR-3288 (QA at 390px): Confirm sat to the right at 24px and squeezed the text.
  it('draws Confirm under the text, full width and 44px tall', () => {
    renderList([{ ...DEPLOY, confirmation: { ...DEPLOY.confirmation, notSent: 3 } }]);
    expect(screen.getByText('3 messages not sent. Confirm what it sends.')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm this setting' });
    expect(confirm).toHaveClass('h-11', 'w-full');
    // Under the text, in the text column: after the lines it answers.
    const source = screen.getByText('Webhook · env:DEPLOY_TOKEN → xn--hks-ted.example.dev');
    expect(source.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Confirm this setting' })).toHaveLength(1);
  });

  it('shows nothing when no connection is paused', () => {
    renderList([]);
    expect(screen.queryByText(/is paused/)).not.toBeInTheDocument();
  });

  it('says what it sends and where (ASCII host), what it dropped, and confirms exactly that', async () => {
    const user = userEvent.setup();
    const transport = renderList([DEPLOY]);

    // Two lines under the title: the notice, then the source line.
    expect(screen.getByText('Deploy hooks is paused')).toBeInTheDocument();
    expect(screen.getByText('1 message not sent. Confirm what it sends.')).toBeInTheDocument();
    const source = screen.getByText('Webhook · env:DEPLOY_TOKEN → xn--hks-ted.example.dev');
    expect(source).toHaveAttribute('title', 'env:DEPLOY_TOKEN');
    expect(screen.queryByText('Paused · confirm the setting it sends.')).not.toBeInTheDocument();

    // The hint sits behind ⓘ, and is still the button's description.
    const hint =
      'Lets it send DEPLOY_TOKEN to xn--hks-ted.example.dev again. Nothing else changes.';
    const button = screen.getByRole('button', { name: 'Confirm this setting' });
    expect(button).toHaveAccessibleDescription(hint);
    await user.click(screen.getByRole('button', { name: 'More about this' }));
    expect(screen.getAllByText(hint).length).toBeGreaterThan(0);

    await user.click(button);
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
