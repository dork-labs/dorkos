// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AdvancedTab } from '../ui/AdvancedTab';

// Mock child dialogs to isolate AdvancedTab behavior
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

/**
 * A wrapper whose transport is reachable, for the rows that WRITE. The
 * `createWrapper` above builds its transport privately, which is all the
 * read-only rows need.
 *
 * @param config - What `getConfig` resolves to, including the `ui` block.
 */
function createConfigHarness(config: Record<string, unknown>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      logging: { level: 'info', maxLogSizeKb: 500, maxLogFiles: 14 },
      ...config,
    }),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { wrapper, transport, queryClient };
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

  // The clean slate for interface settings lives here and only here (DOR-923):
  // the Appearance panel's own reset stops at theme and typography.
  it('renders the Reset All Settings row, and its button says which reset it is', () => {
    render(<AdvancedTab />, { wrapper: createWrapper() });
    expect(screen.getByText('Reset All Settings')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset Data' })).toBeInTheDocument();
  });

  it('asks for a confirm before resetting settings — the dialog opens, nothing resets on the click', () => {
    render(<AdvancedTab />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('reset-settings-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset Settings' }));

    expect(screen.getByTestId('reset-settings-dialog')).toBeInTheDocument();
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

  it('renders the message-box formatting row in plain words', () => {
    render(<AdvancedTab />, { wrapper: createWrapper() });
    // The exact copy is the deliverable: no "Lexical", no "WYSIWYG", no "rich
    // text editor", no "experimental" in the label. A smart 9th grader who does
    // not code has to understand what turning it on does.
    expect(screen.getByText('Format text as you type')).toBeInTheDocument();
    expect(
      screen.getByText(
        'See bold, headings, and lists take shape in the message box while you write.'
      )
    ).toBeInTheDocument();
    // It says WHERE rather than implying everywhere — chat only, at ship time.
    expect(screen.getByText(/This applies to chat for now/i)).toBeInTheDocument();
  });

  it('the formatting row is on when nobody has turned it off', () => {
    // The shipped default since 2026-08-12. This wrapper's config carries no
    // `ui` block at all, so what the switch shows here is exactly what a person
    // who never opened this tab gets.
    render(<AdvancedTab />, { wrapper: createWrapper() });
    expect(screen.getByRole('switch', { name: /Format text as you type/i })).toBeChecked();
  });

  it('reflects the stored value when the preference is on', async () => {
    const { wrapper } = createConfigHarness({ ui: { composer: { richText: true } } });
    render(<AdvancedTab />, { wrapper });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /Format text as you type/i })).toBeChecked()
    );
  });

  it('toggling it on writes exactly the composer subtree', async () => {
    const { wrapper, transport } = createConfigHarness({ ui: { composer: { richText: false } } });
    render(<AdvancedTab />, { wrapper });

    // Wait for the stored `false` to arrive before clicking. Config resolves a
    // tick late and the default is now `true`, so a click on the first render
    // would toggle a switch that is still showing the default and write the
    // opposite of what this test claims to be testing.
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /Format text as you type/i })).not.toBeChecked()
    );
    fireEvent.click(screen.getByRole('switch', { name: /Format text as you type/i }));

    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(1));
    expect(transport.updateConfig).toHaveBeenCalledWith({ ui: { composer: { richText: true } } });
  });

  it('toggling it back off writes false, so the switch is a real exit', async () => {
    const { wrapper, transport } = createConfigHarness({ ui: { composer: { richText: true } } });
    render(<AdvancedTab />, { wrapper });

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /Format text as you type/i })).toBeChecked()
    );
    fireEvent.click(screen.getByRole('switch', { name: /Format text as you type/i }));

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ ui: { composer: { richText: false } } })
    );
  });

  it('keeps the log path reading left-to-right inside its rtl span (DOR-1686)', async () => {
    // Same trade as ServerTab's config rows: the path is clipped at the front
    // so the folder name survives, which means an rtl paragraph, which means
    // the leading `/` is drawn at the right-hand end unless the value is
    // isolated (measured in Chromium: `/Users/kai/.dork/logs` painted as
    // `Users/kai/.dork/logs/`). The leading edge is the only one at risk here,
    // because this value always ends in `/logs`.
    //
    // **jsdom does no bidi layout**, so this pins the structure the browser
    // needs and not the glyph order, which only a browser can show.
    const { wrapper } = createConfigHarness({ dorkHome: '/Users/kai/.dork' });
    render(<AdvancedTab />, { wrapper });

    const isolated = await screen.findByText('/Users/kai/.dork/logs');
    expect(isolated.tagName).toBe('BDI');
    expect(isolated).toHaveAttribute('dir', 'ltr');
    expect(isolated.textContent).toBe('/Users/kai/.dork/logs');
    expect(isolated.parentElement).toHaveAttribute('dir', 'rtl');
    // `truncate` is half the mechanism: without it the rtl box never clips, and
    // the front ellipsis this row exists for is gone while `dir` still passes.
    expect(isolated.parentElement).toHaveClass('truncate');
  });

  it('opens ResetDialog when the Reset Data button is clicked', () => {
    render(<AdvancedTab />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Data' }));
    expect(screen.getByTestId('reset-dialog')).toBeInTheDocument();
    // The settings reset is a different door — clicking data must not open it.
    expect(screen.queryByTestId('reset-settings-dialog')).not.toBeInTheDocument();
  });

  it('opens RestartDialog when Restart button is clicked', () => {
    render(<AdvancedTab />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /restart/i }));
    expect(screen.getByTestId('restart-dialog')).toBeInTheDocument();
  });
});
