/**
 * Settings → Extensions → "Trusted sources" (spec `flow-multiproject` §9.3):
 * the list, and "Stop trusting" through the person-only route.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TrustedSourcesSection } from '../ui/TrustedSourcesSection';

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<TrustedSourcesSection />, { wrapper: Wrapper });
}

describe('TrustedSourcesSection', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('draws nothing when no source is trusted', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sources: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = renderSection();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each source and stops trusting one', async () => {
    const calls: Array<{ method?: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ method: init?.method, body: init?.body as string | undefined });
        return new Response(
          JSON.stringify({
            sources: [{ source: 'dork-labs/marketplace', trustedAt: '2026-09-29T12:00:00.000Z' }],
          })
        );
      })
    );
    const user = userEvent.setup();
    renderSection();

    expect(await screen.findByText('dork-labs/marketplace')).toBeInTheDocument();
    expect(screen.getByText(/^Trusted Sep/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop trusting' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'DELETE',
        body: JSON.stringify({ source: 'dork-labs/marketplace' }),
      })
    );
  });
});
