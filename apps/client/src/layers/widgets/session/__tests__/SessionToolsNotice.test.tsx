/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockSession, createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { SessionToolsNotice } from '../ui/SessionToolsNotice';

afterEach(cleanup);

describe('SessionToolsNotice', () => {
  it.each([true, false])(
    'shows only the server-reported warning (no tools: %s)',
    async (noTools) => {
      const getSession = vi.fn().mockResolvedValue(
        createMockSession({
          id: 'chat-1',
          runtime: 'codex',
          ...(noTools
            ? {
                warnings: [
                  {
                    code: 'NO_DORKOS_TOOLS' as const,
                    message: 'This chat has no DorkOS tools.',
                  },
                ],
              }
            : {}),
        })
      );
      const transport = createMockTransport({ getSession });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <TransportProvider transport={transport}>
            <SessionToolsNotice sessionId="chat-1" />
          </TransportProvider>
        </QueryClientProvider>
      );
      if (noTools) {
        const notice = await screen.findByRole('status');
        expect(notice).toHaveTextContent('This chat has no DorkOS tools.');
        // The unplugged icon is decoration: hidden from screen readers.
        expect(notice.querySelector('svg.lucide-unplug')).toHaveAttribute('aria-hidden');
      } else {
        await waitFor(() => expect(getSession).toHaveBeenCalledWith('chat-1', undefined));
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
      }
      client.clear();
    }
  );
});

describe('SessionToolsNotice for a chat that loses its tools (DOR-4393)', () => {
  /** Render the notice over a row carrying `dorkosTools`. */
  function renderWith(dorkosTools: 'lost' | 'back' | null | undefined, runtime = 'codex') {
    const getSession = vi.fn().mockResolvedValue(
      createMockSession({
        id: 'chat-2',
        runtime,
        ...(dorkosTools !== undefined ? { dorkosTools } : {}),
      })
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TransportProvider transport={createMockTransport({ getSession })}>
          <SessionToolsNotice sessionId="chat-2" />
        </TransportProvider>
      </QueryClientProvider>
    );
    return getSession;
  }

  it('says the tools were lost, that it retries with the next message, with an unplugged icon', async () => {
    renderWith('lost');
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(
      "This chat lost its DorkOS tools. It can still answer, but can't act in DorkOS."
    );
    expect(notice).toHaveTextContent('It tries again with your next message.');
    expect(notice).toHaveAttribute('aria-live', 'polite');
    expect(notice.querySelector('svg.lucide-unplug')).toHaveAttribute('aria-hidden');
    // Option (b): no button that cannot fix it.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says the tools are back, with a plug icon', async () => {
    renderWith('back');
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent("This chat's DorkOS tools are back.");
    expect(notice).not.toHaveTextContent('lost');
    expect(notice.querySelector('svg.lucide-plug')).toHaveAttribute('aria-hidden');
  });

  it.each([null, undefined])('shows nothing when the row says %s', async (state) => {
    const getSession = renderWith(state, 'claude-code');
    await waitFor(() => expect(getSession).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
