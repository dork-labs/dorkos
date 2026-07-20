/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useImportProjectsStore } from '@/layers/shared/model';
import { ImportProjectsDialog } from '../ui/ImportProjectsDialog';

// Stand in for the heavy discovery UI: a single button that reports one join,
// so the dialog's completion state can be driven deterministically.
vi.mock('../ui/DiscoveryView', () => ({
  DiscoveryView: ({ onRegistered }: { onRegistered?: () => void }) => (
    <button data-testid="fake-join" onClick={() => onRegistered?.()}>
      Join a project
    </button>
  ),
}));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('ImportProjectsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useImportProjectsStore.setState({ isOpen: false });
  });

  afterEach(cleanup);

  it('is closed until the store opens it', () => {
    render(<ImportProjectsDialog />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    useImportProjectsStore.getState().open();
    // Re-render happens via store subscription; assert the title appears.
    return waitFor(() =>
      expect(screen.getByText('Bring in existing projects')).toBeInTheDocument()
    );
  });

  it('Done with nothing joined just closes — no navigation', async () => {
    const user = userEvent.setup();
    render(<ImportProjectsDialog />);
    useImportProjectsStore.getState().open();
    await screen.findByRole('dialog');

    await user.click(screen.getByTestId('import-done'));

    await waitFor(() => expect(useImportProjectsStore.getState().isOpen).toBe(false));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('counts joins, shows a completion summary, then closes and lands on Agents', async () => {
    const user = userEvent.setup();
    render(<ImportProjectsDialog />);
    useImportProjectsStore.getState().open();
    await screen.findByRole('dialog');

    // Bring in two projects.
    await user.click(screen.getByTestId('fake-join'));
    await user.click(screen.getByTestId('fake-join'));
    await waitFor(() =>
      expect(screen.getByTestId('import-joined-count')).toHaveTextContent('2 projects joined')
    );

    // First Done → completion summary (still open).
    await user.click(screen.getByTestId('import-done'));
    expect(await screen.findByTestId('import-complete')).toBeInTheDocument();
    expect(screen.getByTestId('import-joined-summary')).toHaveTextContent('2 projects joined');
    expect(useImportProjectsStore.getState().isOpen).toBe(true);

    // Second Done → close + navigate to the Agents page.
    await user.click(screen.getByTestId('import-done'));
    await waitFor(() => expect(useImportProjectsStore.getState().isOpen).toBe(false));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents' });
  });

  it('resets the join count when reopened', async () => {
    const user = userEvent.setup();
    render(<ImportProjectsDialog />);

    useImportProjectsStore.getState().open();
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('fake-join'));
    await waitFor(() =>
      expect(screen.getByTestId('import-joined-count')).toHaveTextContent('1 project joined')
    );

    useImportProjectsStore.getState().close();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    useImportProjectsStore.getState().open();
    await screen.findByRole('dialog');
    expect(screen.queryByTestId('import-joined-count')).not.toBeInTheDocument();
  });
});
