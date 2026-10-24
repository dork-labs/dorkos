/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { getPrefersReducedMotion } from '@/test-setup';
import { SidebarFoldBody } from '../ui/motion/SidebarFoldBody';

// The REAL motion library: what is under test is the moment the body's exit
// completes, which the global stand-in (an `AnimatePresence` that renders its
// children and never exits) cannot report.
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => getPrefersReducedMotion(),
}));

afterEach(cleanup);

/** A fold whose body and folded view both hold the same row, as a real section's do. */
function fold(open: boolean) {
  return (
    <SidebarFoldBody open={open} whenFolded={<div data-testid="kept">#general</div>}>
      <div data-testid="body">#general</div>
    </SidebarFoldBody>
  );
}

describe('SidebarFoldBody', () => {
  it('shows what a folded section keeps at once when it paints folded', () => {
    render(fold(false));
    expect(screen.getByTestId('kept')).toBeInTheDocument();
    expect(screen.queryByTestId('body')).not.toBeInTheDocument();
  });

  it('never draws a row twice while the body is closing', async () => {
    const { rerender } = render(fold(true));
    expect(screen.queryByTestId('kept')).not.toBeInTheDocument();

    rerender(fold(false));
    // While the body leaves, the kept copy is not there yet: never two copies,
    // which is what a test finding the row by its name would trip over.
    expect(screen.queryAllByText('#general').length).toBeLessThanOrEqual(1);
    await waitFor(() => expect(screen.getByTestId('kept')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.queryByTestId('body')).not.toBeInTheDocument();
    expect(screen.getAllByText('#general')).toHaveLength(1);
  });

  it('takes the kept rows away the moment the section opens again', () => {
    const { rerender } = render(fold(false));
    rerender(fold(true));
    expect(screen.queryByTestId('kept')).not.toBeInTheDocument();
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });
});
