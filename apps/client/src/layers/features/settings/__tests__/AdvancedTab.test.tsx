// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AdvancedTab } from '../ui/AdvancedTab';

// Mock child dialogs to isolate AdvancedTab behavior
vi.mock('../ui/ResetDialog', () => ({
  ResetDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="reset-dialog">Reset Dialog</div> : null,
}));

vi.mock('../ui/RestartDialog', () => ({
  RestartDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="restart-dialog">Restart Dialog</div> : null,
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      logging: { level: 'info', maxLogSizeKb: 500, maxLogFiles: 14 },
    }),
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('AdvancedTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the Danger Zone heading', () => {
    render(<AdvancedTab />, { wrapper: createWrapper() });
    expect(screen.getByText('Danger Zone')).toBeInTheDocument();
  });

  it('renders Reset All Data and Restart Server rows', () => {
    render(<AdvancedTab />, { wrapper: createWrapper() });
    expect(screen.getByText('Reset All Data')).toBeInTheDocument();
    expect(screen.getByText('Restart Server')).toBeInTheDocument();
  });

  it('retains the Background refresh row', () => {
    render(<AdvancedTab />, { wrapper: createWrapper() });
    expect(screen.getByText('Background refresh')).toBeInTheDocument();
  });

  // Background refresh is re-described as an opt-in external-session polling
  // fallback (spec chat-stream-reconnection, ADR-0266): server-side discovery is
  // now primary, so the copy must frame it as a fallback, not a correctness switch.
  it('describes Background refresh as an opt-in external-session fallback', () => {
    render(<AdvancedTab />, { wrapper: createWrapper() });
    // Row description: external-session framing, references the CLI, frames it
    // as opt-in (text unique to the row, not the section copy above it).
    expect(screen.getByText(/Claude Code CLI/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Enable only if external activity isn't appearing promptly/i)
    ).toBeInTheDocument();
    // Section copy: live sync is automatic; this is only an extra fallback.
    expect(screen.getByText(/stay in sync across windows automatically/i)).toBeInTheDocument();
  });

  // Multi-window sync is now always-on (spec chat-stream-reconnection, ADR-0266);
  // the manual toggle was removed — it must not reappear.
  it('no longer renders the Multi-window sync toggle', () => {
    render(<AdvancedTab />, { wrapper: createWrapper() });
    expect(screen.queryByText('Multi-window sync')).not.toBeInTheDocument();
  });

  it('opens ResetDialog when Reset button is clicked', () => {
    render(<AdvancedTab />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));
    expect(screen.getByTestId('reset-dialog')).toBeInTheDocument();
  });

  it('opens RestartDialog when Restart button is clicked', () => {
    render(<AdvancedTab />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /restart/i }));
    expect(screen.getByTestId('restart-dialog')).toBeInTheDocument();
  });
});
