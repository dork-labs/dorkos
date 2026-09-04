// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { DangerZoneTab } from '../ui/DangerZoneTab';

// Mock child dialogs to isolate DangerZoneTab behavior
vi.mock('../ui/ResetDialog', () => ({
  ResetDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="reset-dialog">Reset Dialog</div> : null,
}));

vi.mock('../ui/ResetSettingsDialog', () => ({
  ResetSettingsDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="reset-settings-dialog">Reset Settings Dialog</div> : null,
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

describe('DangerZoneTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Reset all data and Restart DorkOS rows', () => {
    render(<DangerZoneTab />, { wrapper: createWrapper() });
    expect(screen.getByText('Reset all data')).toBeInTheDocument();
    expect(screen.getByText('Restart DorkOS')).toBeInTheDocument();
  });

  // The clean slate for interface settings lives here and only here (DOR-923):
  // the Appearance panel's own reset stops at theme and typography.
  it('renders the Reset all settings row, and its button says which reset it is', () => {
    render(<DangerZoneTab />, { wrapper: createWrapper() });
    expect(screen.getByText('Reset all settings')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset data' })).toBeInTheDocument();
  });

  it('asks for a confirm before resetting settings — the dialog opens, nothing resets on the click', () => {
    render(<DangerZoneTab />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('reset-settings-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset settings' }));

    expect(screen.getByTestId('reset-settings-dialog')).toBeInTheDocument();
  });

  // The tab is named after what it holds now (DOR-1758). Everything the old
  // "Advanced" junk drawer also carried went somewhere its name predicts: the
  // message box and background refresh to Preferences, logging to Server.
  it('holds nothing but the destructive actions', () => {
    render(<DangerZoneTab />, { wrapper: createWrapper() });
    expect(
      screen.queryByText('Watch for agents you started somewhere else')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Format text as you type')).not.toBeInTheDocument();
    expect(screen.queryByText('Log level')).not.toBeInTheDocument();
    expect(screen.queryByText('Log location')).not.toBeInTheDocument();
  });

  // One heading per panel is the dialog's (DOR-918), and the panel's own header
  // now says "Danger zone" — so the tab may not say it again.
  it('draws no heading of its own', () => {
    render(<DangerZoneTab />, { wrapper: createWrapper() });
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('opens ResetDialog when the Reset data button is clicked', () => {
    render(<DangerZoneTab />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: 'Reset data' }));
    expect(screen.getByTestId('reset-dialog')).toBeInTheDocument();
    // The settings reset is a different door — clicking data must not open it.
    expect(screen.queryByTestId('reset-settings-dialog')).not.toBeInTheDocument();
  });

  it('opens RestartDialog when Restart button is clicked', () => {
    render(<DangerZoneTab />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /restart/i }));
    expect(screen.getByTestId('restart-dialog')).toBeInTheDocument();
  });
});
