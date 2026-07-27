// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ServerTab } from '../ui/ServerTab';

/**
 * The tab exists to answer one question a desktop user could not answer any
 * other way: what address is DorkOS on right now? The app asks for 4242 and
 * takes the next free port when something else has it, so these tests use a
 * port that is deliberately *not* the default — an implementation that printed
 * a hardcoded 4242 would pass against 4242 and be useless in the case that
 * matters.
 */
const PORT = 4243;

function renderTab(port = PORT) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.2.3',
      isDevMode: false,
      port,
      uptime: 90,
      workingDirectory: '/Users/kai/code',
      dorkHome: '/Users/kai/.dork',
      boundary: '/Users/kai',
      nodeVersion: 'v22.0.0',
    }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ServerTab />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('ServerTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    delete window.electronAPI;
  });

  it('shows the address the running server actually reported', async () => {
    renderTab();

    expect(await screen.findByText(`http://localhost:${PORT}`)).toBeInTheDocument();
  });

  it('shows the MCP endpoint on the same address, so external clients can be pointed at it', async () => {
    renderTab();

    expect(await screen.findByText(`http://localhost:${PORT}/mcp`)).toBeInTheDocument();
  });

  it('copies each address', async () => {
    const user = userEvent.setup();
    // After `setup()`, which installs a clipboard stub of its own that would
    // otherwise shadow this one.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderTab();

    await user.click(await screen.findByRole('button', { name: /copy the dorkos address/i }));
    expect(writeText).toHaveBeenCalledWith(`http://localhost:${PORT}`);

    await user.click(screen.getByRole('button', { name: /copy the mcp endpoint/i }));
    expect(writeText).toHaveBeenCalledWith(`http://localhost:${PORT}/mcp`);
  });

  it('leaves the app when asked to open the address in a browser', async () => {
    // In the desktop shell this URL is the app's own origin, where `window.open`
    // builds a second cockpit window instead of leaving. The seam prefers the
    // preload bridge for exactly that reason.
    const openExternal = vi.fn().mockResolvedValue(undefined);
    window.electronAPI = { openExternal } as unknown as ElectronAPI;
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: /open dorkos in your browser/i }));

    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(`http://localhost:${PORT}/`));
  });

  it('offers no way to open the MCP endpoint — it is a URL to paste, not to visit', async () => {
    renderTab();
    await screen.findByText(`http://localhost:${PORT}/mcp`);

    expect(screen.getAllByRole('button', { name: /open dorkos in your browser/i })).toHaveLength(1);
  });

  it('still reports the rest of the environment', async () => {
    renderTab();

    expect(await screen.findByText('/Users/kai/.dork')).toBeInTheDocument();
    expect(screen.getByText('v22.0.0')).toBeInTheDocument();
    expect(screen.getByText('1m 30s')).toBeInTheDocument();
  });
});
