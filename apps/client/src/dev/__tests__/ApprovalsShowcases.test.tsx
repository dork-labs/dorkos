/**
 * Smoke test for the approvals showcase.
 *
 * A broken showcase fails silently: nobody notices until they open the playground
 * looking for the answer to a layout question. This renders it over a mock
 * transport and checks the two width columns that are the whole reason it exists.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ApprovalsShowcases } from '../showcases/ApprovalsShowcases';

/** Render the showcase inside the providers the dev playground supplies. */
function renderShowcase() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={createMockTransport()}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return render(<ApprovalsShowcases />, { wrapper: Wrapper });
}

describe('ApprovalsShowcases', () => {
  afterEach(() => cleanup());

  it('renders every section the registry advertises', () => {
    renderShowcase();

    expect(screen.getByRole('heading', { name: /ApprovalCard/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /ApprovalList/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /ApprovalsUnavailable/ })).toBeInTheDocument();
  });

  it('draws the same card at both decision widths', () => {
    // The point of the showcase: the header popover is now the primary place a
    // person answers, and it is roughly half the dashboard's width.
    renderShowcase();

    // The popover column appears in both the card and the list section.
    expect(screen.getAllByText(/Header popover \(424px\)/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Dashboard section \(848px\)/)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="approval-card"]').length).toBeGreaterThan(1);
  });

  it('shows the queue cap holding requests back', () => {
    renderShowcase();

    expect(screen.getByText(/2 more requests are waiting/)).toBeInTheDocument();
  });
});
