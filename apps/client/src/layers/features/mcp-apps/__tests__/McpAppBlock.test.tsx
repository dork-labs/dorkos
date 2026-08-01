/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { McpAppBlock } from '../ui/McpAppBlock';
import { grantRenderConsent } from '../model/render-consent';

function renderBlock() {
  const transport = createMockTransport();
  transport.fetchMcpAppResource = vi.fn().mockResolvedValue({
    mimeType: 'text/html',
    text: '<html><head></head><body>app</body></html>',
    permissions: [],
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <McpAppBlock sessionId="s1" serverName="fixture-app" uri="ui://dash/main" title="Dash" />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, ...utils };
}

describe('McpAppBlock first-use consent gate', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useAppStore.setState({ pipContent: null });
  });
  afterEach(cleanup);

  it('shows a consent card naming the server and does not fetch until consented', () => {
    const { transport, container } = renderBlock();
    expect(screen.getByText(/Interactive app provided by fixture-app/i)).toBeInTheDocument();
    expect(container.querySelector('iframe')).toBeNull();
    expect(transport.fetchMcpAppResource).not.toHaveBeenCalled();
  });

  it('renders the sandboxed app after the user grants consent', async () => {
    const user = userEvent.setup();
    const { transport, container } = renderBlock();

    await user.click(screen.getByRole('button', { name: /render app/i }));

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(transport.fetchMcpAppResource).toHaveBeenCalledWith('s1', {
      serverName: 'fixture-app',
      uri: 'ui://dash/main',
    });
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
  });
});

describe('McpAppBlock pop-out (PIP) affordance', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useAppStore.setState({ pipContent: null });
    // Pre-consent so the block renders its header (with the pop-out control)
    // rather than the consent card.
    grantRenderConsent('fixture-app');
  });
  afterEach(cleanup);

  it('opens the PIP panel with the mcp_app descriptor when the pop-out button is clicked', async () => {
    const user = userEvent.setup();
    renderBlock();

    await user.click(screen.getByRole('button', { name: /pop out into a floating window/i }));

    expect(useAppStore.getState().pipContent).toEqual({
      kind: 'mcp_app',
      sessionId: 's1',
      serverName: 'fixture-app',
      uri: 'ui://dash/main',
      title: 'Dash',
    });
  });

  it('shows the pop-out button with no viewport gate (mobile docks a bottom sheet, DOR-299)', () => {
    renderBlock();

    expect(
      screen.getByRole('button', { name: /pop out into a floating window/i })
    ).toBeInTheDocument();
    // The canvas (maximize) affordance still works on mobile too.
    expect(screen.getByRole('button', { name: /open in canvas/i })).toBeInTheDocument();
  });

  it('opens the App in the canvas AND reveals it, rather than into a shut panel', async () => {
    // The canvas renders inside the right panel, so writing the legacy
    // `canvasOpen` flag alone put the App somewhere nobody could see it
    // (DOR-97, DOR-829). All three writes, or nothing happened.
    useAppStore.setState({
      openDocuments: [],
      activeDocumentId: null,
      canvasOpen: false,
      rightPanelOpen: false,
      activeRightPanelTab: null,
    });
    const user = userEvent.setup();
    renderBlock();

    await user.click(screen.getByRole('button', { name: /open in canvas/i }));

    const { openDocuments, canvasOpen, rightPanelOpen, activeRightPanelTab } =
      useAppStore.getState();
    expect(openDocuments).toHaveLength(1);
    expect(openDocuments[0].content).toEqual({
      type: 'mcp_app',
      serverName: 'fixture-app',
      uri: 'ui://dash/main',
      title: 'Dash',
    });
    expect(canvasOpen).toBe(true);
    expect(rightPanelOpen).toBe(true);
    expect(activeRightPanelTab).toBe('canvas');
  });
});
