// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { RestartDialog } from '../ui/RestartDialog';
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

describe('RestartDialog', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onRestartComplete: vi.fn(),
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

  it('displays confirmation text about active sessions', () => {
    render(<RestartDialog {...defaultProps} />, { wrapper: Wrapper });
    expect(screen.getByText(/Anything running right now stops/i)).toBeInTheDocument();
  });

  it('calls transport.restartServer on confirm', async () => {
    render(<RestartDialog {...defaultProps} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Restart DorkOS' }));
    await waitFor(() => {
      expect(mockTransport.restartServer).toHaveBeenCalled();
    });
  });

  it('calls onRestartComplete callback on success', async () => {
    render(<RestartDialog {...defaultProps} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Restart DorkOS' }));
    await waitFor(() => {
      expect(defaultProps.onRestartComplete).toHaveBeenCalled();
    });
  });

  describe('in the desktop app (DOR-542)', () => {
    afterEach(() => {
      delete window.electronAPI;
    });

    /** Install a shell bridge that answers `restartServer` with `result`. */
    function installShell(result: DesktopAdminResult) {
      const restartServer = vi.fn().mockResolvedValue(result);
      window.electronAPI = {
        restartServer,
        resetAllData: vi.fn().mockResolvedValue({ ok: true }),
      } as unknown as ElectronAPI;
      return restartServer;
    }

    it('asks the shell instead of the server, which cannot restart itself here', async () => {
      const restartServer = installShell({ ok: true });
      render(<RestartDialog {...defaultProps} />, { wrapper: Wrapper });

      fireEvent.click(screen.getByRole('button', { name: /restart server/i }));

      await waitFor(() => expect(restartServer).toHaveBeenCalled());
      // The HTTP route answers 409 when a supervisor owns the server, so
      // reaching for it here is how the button died in the first place.
      expect(mockTransport.restartServer).not.toHaveBeenCalled();
      expect(defaultProps.onRestartComplete).toHaveBeenCalled();
    });

    it("shows the shell's own words when it could not restart", async () => {
      installShell({
        ok: false,
        message: "DorkOS couldn't restart its server. Port 4242 is taken.",
      });
      render(<RestartDialog {...defaultProps} />, { wrapper: Wrapper });

      fireEvent.click(screen.getByRole('button', { name: /restart server/i }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "DorkOS couldn't restart its server. Port 4242 is taken."
        )
      );
      expect(defaultProps.onRestartComplete).not.toHaveBeenCalled();
    });

    it('falls back to the server on a shell that predates the bridge', async () => {
      // An older desktop build exposes neither call. It gets the 409 and its
      // explanation, which is the best answer available there.
      window.electronAPI = { getServerPort: () => 4242 } as unknown as ElectronAPI;
      render(<RestartDialog {...defaultProps} />, { wrapper: Wrapper });

      fireEvent.click(screen.getByRole('button', { name: /restart server/i }));

      await waitFor(() => expect(mockTransport.restartServer).toHaveBeenCalled());
    });
  });
});
