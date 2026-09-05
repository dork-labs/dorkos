// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ResetDialog } from '../ui/ResetDialog';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { toast } from 'sonner';

// Mock Radix AlertDialog portal to render inline (prevents document.body duplication)
vi.mock('@radix-ui/react-alert-dialog', async () => {
  const actual = await vi.importActual<typeof import('@radix-ui/react-alert-dialog')>(
    '@radix-ui/react-alert-dialog'
  );
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe('ResetDialog', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onResetComplete: vi.fn(),
  };

  function Wrapper({ children }: { children: React.ReactNode }) {
    return <TransportProvider transport={mockTransport}>{children}</TransportProvider>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = createMockTransport();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders submit button as disabled initially', () => {
    render(<ResetDialog {...defaultProps} />, { wrapper: Wrapper });
    expect(screen.getByRole('button', { name: /reset all data/i })).toBeDisabled();
  });

  it('keeps submit disabled when wrong text is typed', () => {
    render(<ResetDialog {...defaultProps} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByTestId('reset-confirm-input'), { target: { value: 'delete' } });
    expect(screen.getByRole('button', { name: /reset all data/i })).toBeDisabled();
  });

  it('enables submit when "reset" is typed', () => {
    render(<ResetDialog {...defaultProps} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByTestId('reset-confirm-input'), { target: { value: 'reset' } });
    expect(screen.getByRole('button', { name: /reset all data/i })).toBeEnabled();
  });

  it('calls transport.resetAllData on submit', async () => {
    render(<ResetDialog {...defaultProps} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByTestId('reset-confirm-input'), { target: { value: 'reset' } });
    fireEvent.click(screen.getByRole('button', { name: /reset all data/i }));
    await waitFor(() => {
      expect(mockTransport.resetAllData).toHaveBeenCalledWith('reset');
    });
  });

  it('clears localStorage on success', async () => {
    const clearSpy = vi.spyOn(Storage.prototype, 'clear');
    render(<ResetDialog {...defaultProps} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByTestId('reset-confirm-input'), { target: { value: 'reset' } });
    fireEvent.click(screen.getByRole('button', { name: /reset all data/i }));
    await waitFor(() => {
      expect(clearSpy).toHaveBeenCalled();
    });
    clearSpy.mockRestore();
  });

  it('calls onResetComplete callback on success', async () => {
    render(<ResetDialog {...defaultProps} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByTestId('reset-confirm-input'), { target: { value: 'reset' } });
    fireEvent.click(screen.getByRole('button', { name: /reset all data/i }));
    await waitFor(() => {
      expect(defaultProps.onResetComplete).toHaveBeenCalled();
    });
  });

  describe('in the desktop app (DOR-542)', () => {
    afterEach(() => {
      delete window.electronAPI;
    });

    /** Install a shell bridge that answers `resetAllData` with `result`. */
    function installShell(result: DesktopAdminResult) {
      const resetAllData = vi.fn().mockResolvedValue(result);
      window.electronAPI = {
        restartServer: vi.fn().mockResolvedValue({ ok: true }),
        resetAllData,
      } as unknown as ElectronAPI;
      return resetAllData;
    }

    /** Type the confirmation and press the button. */
    function confirmReset() {
      fireEvent.change(screen.getByTestId('reset-confirm-input'), { target: { value: 'reset' } });
      fireEvent.click(screen.getByRole('button', { name: /reset all data/i }));
    }

    it('asks the shell, which can delete the folder its server had open', async () => {
      const resetAllData = installShell({ ok: true });
      render(<ResetDialog {...defaultProps} />, { wrapper: Wrapper });

      confirmReset();

      await waitFor(() => expect(resetAllData).toHaveBeenCalled());
      expect(mockTransport.resetAllData).not.toHaveBeenCalled();
      expect(defaultProps.onResetComplete).toHaveBeenCalled();
    });

    it('clears this page before the shell can reload it', async () => {
      const clearSpy = vi.spyOn(Storage.prototype, 'clear');
      let clearedBeforeTheCall = false;
      window.electronAPI = {
        restartServer: vi.fn(),
        // The shell puts this window on the restarted server as soon as it is
        // up, so preferences cleared afterwards might never be cleared at all.
        resetAllData: vi.fn().mockImplementation(() => {
          clearedBeforeTheCall = clearSpy.mock.calls.length > 0;
          return Promise.resolve({ ok: true });
        }),
      } as unknown as ElectronAPI;
      render(<ResetDialog {...defaultProps} />, { wrapper: Wrapper });

      confirmReset();

      await waitFor(() => expect(defaultProps.onResetComplete).toHaveBeenCalled());
      expect(clearedBeforeTheCall).toBe(true);
      clearSpy.mockRestore();
    });

    it('puts this page back when the reset it cleared for did not happen', async () => {
      // Clearing first is only safe because it is undone: a reset the shell
      // refused deleted nothing, and it must not be the reason someone's theme
      // and panel layouts went with it.
      localStorage.setItem('dorkos.theme', 'dark');
      localStorage.setItem('dorkos.sidebar', '{"width":320}');
      installShell({ ok: false, message: 'Nothing was deleted.' });
      render(<ResetDialog {...defaultProps} />, { wrapper: Wrapper });

      confirmReset();

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(localStorage.getItem('dorkos.theme')).toBe('dark');
      expect(localStorage.getItem('dorkos.sidebar')).toBe('{"width":320}');
      localStorage.clear();
    });

    it("shows the shell's own words when nothing was deleted", async () => {
      installShell({
        ok: false,
        message:
          'Another copy of DorkOS is using this folder right now — process 812, on port 4242. ' +
          'Nothing was deleted. Quit that copy, then try again.',
      });
      render(<ResetDialog {...defaultProps} />, { wrapper: Wrapper });

      confirmReset();

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Nothing was deleted'))
      );
      expect(defaultProps.onResetComplete).not.toHaveBeenCalled();
    });

    it('falls back to the server on a shell that predates the bridge', async () => {
      window.electronAPI = { getServerPort: () => 4242 } as unknown as ElectronAPI;
      render(<ResetDialog {...defaultProps} />, { wrapper: Wrapper });

      confirmReset();

      await waitFor(() => expect(mockTransport.resetAllData).toHaveBeenCalledWith('reset'));
    });
  });
});
