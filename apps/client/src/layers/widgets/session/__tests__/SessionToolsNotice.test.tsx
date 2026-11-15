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
