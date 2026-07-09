/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

// The `celebrating` mood fires confetti on mount; stub it so tests don't
// exercise the real canvas-confetti dynamic import under jsdom.
vi.mock('@/layers/shared/lib', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/lib');
  return { ...actual, fireConfetti: vi.fn().mockResolvedValue(vi.fn()) };
});

afterEach(cleanup);
import type { ReactNode } from 'react';
import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { WidgetRenderer } from '../ui/WidgetRenderer';
import { WidgetFence } from '../ui/WidgetFence';
import { WidgetErrorCard } from '../ui/WidgetErrorCard';

const mockTransport = createMockTransport();

/** Widgets need a Transport in context (agent actions POST through it). */
function Wrapper({ children }: { children: ReactNode }) {
  return <TransportProvider transport={mockTransport}>{children}</TransportProvider>;
}

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
});

function renderDoc(root: WidgetDocument['root'], title?: string) {
  render(<WidgetRenderer document={{ version: 1, title, root }} />, { wrapper: Wrapper });
}

describe('WidgetRenderer catalog nodes', () => {
  it('renders a stat card', () => {
    renderDoc({
      type: 'card',
      title: 'Weather',
      children: [{ type: 'stat', label: 'San Francisco', value: '64°F' }],
    });
    expect(screen.getByText('Weather')).toBeInTheDocument();
    expect(screen.getByText('San Francisco')).toBeInTheDocument();
    expect(screen.getByText('64°F')).toBeInTheDocument();
  });

  it('renders a table with columns and rows', () => {
    renderDoc({
      type: 'table',
      columns: [
        { key: 'id', label: 'Issue' },
        { key: 'status', label: 'Status' },
      ],
      rows: [
        { id: 'DOR-1', status: 'open' },
        { id: 'DOR-2', status: null },
      ],
    });
    expect(screen.getByText('Issue')).toBeInTheDocument();
    expect(screen.getByText('DOR-1')).toBeInTheDocument();
    // null cell renders as an em dash
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders a list with a toned badge', () => {
    renderDoc({
      type: 'list',
      items: [{ title: 'Deploy', subtitle: 'prod', badge: { text: 'done', tone: 'success' } }],
    });
    expect(screen.getByText('Deploy')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
  });

  it('renders a bar chart with an accessible label', () => {
    renderDoc({
      type: 'chart',
      kind: 'bar',
      data: [
        { label: 'Mon', value: 10 },
        { label: 'Tue', value: 20 },
      ],
    });
    expect(screen.getByRole('img', { name: 'bar chart' })).toBeInTheDocument();
    expect(screen.getByText('Mon')).toBeInTheDocument();
  });

  it('renders a single-datum pie as a full circle (degenerate-arc guard)', () => {
    const { container } = render(
      <WidgetRenderer
        document={{
          version: 1,
          root: { type: 'chart', kind: 'pie', data: [{ label: 'All', value: 100 }] },
        }}
      />,
      { wrapper: Wrapper }
    );
    const svg = screen.getByRole('img', { name: 'pie chart' });
    expect(svg.querySelector('circle')).not.toBeNull();
    expect(container.querySelectorAll('path')).toHaveLength(0);
  });

  it('uses the document title as the region label', () => {
    renderDoc({ type: 'divider' }, 'My Widget');
    expect(screen.getByRole('region', { name: 'My Widget' })).toBeInTheDocument();
  });
});

describe('widget actions', () => {
  it('routes url actions through the link-safety modal before opening (D4)', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderDoc({
      type: 'button',
      label: 'Open docs',
      action: { kind: 'url', href: 'https://dorkos.ai' },
    });

    await user.click(screen.getByRole('button', { name: 'Open docs' }));
    // Nothing opens directly — the confirmation modal appears first.
    expect(open).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: /open external link/i });
    expect(dialog).toHaveTextContent('https://dorkos.ai');

    await user.click(screen.getByRole('button', { name: /open link/i }));
    expect(open).toHaveBeenCalledWith('https://dorkos.ai', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('does not open the url when the modal is dismissed', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderDoc({
      type: 'button',
      label: 'Open docs',
      action: { kind: 'url', href: 'https://dorkos.ai' },
    });

    await user.click(screen.getByRole('button', { name: 'Open docs' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    open.mockRestore();
  });

  it('degrades a ui open_terminal action to a notice when the transport has no terminal', async () => {
    // A widget firing `open_terminal` under a terminal-less transport
    // (DirectTransport/Obsidian) must surface a notice, not focus a phantom
    // Terminal tab — the same graceful-degradation contract the agent-stream
    // dispatch path honors. Proves supportsTerminal is threaded into the
    // widget's DispatcherContext, not just the agent path.
    const user = userEvent.setup();
    const noTerminalTransport = createMockTransport({ supportsTerminal: false });
    render(
      <TransportProvider transport={noTerminalTransport}>
        <WidgetRenderer
          document={{
            version: 1,
            title: 'Shell',
            root: {
              type: 'button',
              label: 'Open terminal',
              action: { kind: 'ui', command: { action: 'open_terminal' } },
            },
          }}
        />
      </TransportProvider>
    );

    await user.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(toast.info).toHaveBeenCalled();
  });

  it('disables agent actions when no target session is present (e.g. the playground)', () => {
    // renderDoc passes no sessionId, so agent actions cannot dispatch.
    renderDoc({
      type: 'button',
      label: 'Confirm',
      action: { kind: 'agent', id: 'confirm' },
    });
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
  });

  it('dispatches an agent action through the Transport when a session is present', async () => {
    const user = userEvent.setup();
    mockTransport.sendUiAction = vi.fn().mockResolvedValue({ sessionId: 'sess-1' });
    render(
      <WidgetRenderer
        document={{
          version: 1,
          title: 'Weather',
          root: { type: 'button', label: 'Refresh', action: { kind: 'agent', id: 'refresh' } },
        }}
        sessionId="sess-1"
      />,
      { wrapper: Wrapper }
    );
    const button = screen.getByRole('button', { name: 'Refresh' });
    expect(button).not.toHaveAttribute('aria-disabled');
    await user.click(button);
    expect(mockTransport.sendUiAction).toHaveBeenCalledWith('sess-1', {
      actionId: 'refresh',
      payload: undefined,
      widgetTitle: 'Weather',
    });
  });

  it('surfaces an error toast when the agent action POST fails', async () => {
    const user = userEvent.setup();
    mockTransport.sendUiAction = vi.fn().mockRejectedValue(new Error('Session locked'));
    render(
      <WidgetRenderer
        document={{
          version: 1,
          root: { type: 'button', label: 'Go', action: { kind: 'agent', id: 'go' } },
        }}
        sessionId="sess-1"
      />,
      { wrapper: Wrapper }
    );
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't send the action", expect.anything())
    );
  });

  it('merges form field values into the agent action payload on submit', async () => {
    const user = userEvent.setup();
    mockTransport.sendUiAction = vi.fn().mockResolvedValue({ sessionId: 'sess-1' });
    render(
      <WidgetRenderer
        document={{
          version: 1,
          title: 'Search',
          root: {
            type: 'form',
            children: [{ type: 'input', name: 'city', label: 'City' }],
            submit: { label: 'Submit', action: { kind: 'agent', id: 'search' } },
          },
        }}
        sessionId="sess-1"
      />,
      { wrapper: Wrapper }
    );

    await user.type(screen.getByLabelText('City'), 'Berlin');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(mockTransport.sendUiAction).toHaveBeenCalledWith('sess-1', {
      actionId: 'search',
      payload: { city: 'Berlin' },
      widgetTitle: 'Search',
    });
  });
});

describe('Tier-1 utility nodes', () => {
  it('renders a timeline with status-driven styling', () => {
    const { container } = render(
      <WidgetRenderer
        document={{
          version: 1,
          root: {
            type: 'timeline',
            items: [
              { title: 'Depart', status: 'done' },
              { title: 'In transit', status: 'active' },
              { title: 'Arrive', status: 'upcoming' },
            ],
          },
        }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText('Depart')).toBeInTheDocument();
    // The active stop's title is emphasized; done stops carry the success dot.
    expect(screen.getByText('In transit')).toHaveClass('font-semibold');
    expect(container.querySelector('.bg-status-success')).not.toBeNull();
  });

  it('toggles checklist items and posts checked/unchecked labels on submit', async () => {
    const user = userEvent.setup();
    mockTransport.sendUiAction = vi.fn().mockResolvedValue({ sessionId: 'sess-1' });
    render(
      <WidgetRenderer
        document={{
          version: 1,
          title: 'Packing',
          root: {
            type: 'checklist',
            items: [{ label: 'Passport', checked: true }, { label: 'Tickets' }],
            action: { kind: 'agent', id: 'confirm-packing' },
            submitLabel: 'Confirm',
          },
        }}
        sessionId="sess-1"
      />,
      { wrapper: Wrapper }
    );

    // Flip the unchecked "Tickets" item on.
    await user.click(screen.getByRole('checkbox', { name: 'Tickets' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(mockTransport.sendUiAction).toHaveBeenCalledWith('sess-1', {
      actionId: 'confirm-packing',
      payload: { checked: ['Passport', 'Tickets'], unchecked: [] },
      widgetTitle: 'Packing',
    });
  });

  it('renders a compare matrix with check/cross/dash cells and a recommended column', () => {
    renderDoc({
      type: 'compare',
      options: [{ name: 'Basic' }, { name: 'Pro', recommended: true }],
      rows: [
        { label: 'Fast', values: [false, true] },
        { label: 'Seats', values: [1, null] },
      ],
    });
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    expect(screen.getByLabelText('No')).toBeInTheDocument();
    expect(screen.getByLabelText('Yes')).toBeInTheDocument();
    // The ragged/null cell renders as an em dash.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders a rating with an accessible label and fractional fill overlay', () => {
    const { container } = render(
      <WidgetRenderer
        document={{ version: 1, root: { type: 'rating', value: 4.6, count: 2384 } }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByRole('img', { name: 'Rated 4.6 out of 5' })).toBeInTheDocument();
    expect(screen.getByText('4.6')).toBeInTheDocument();
    expect(screen.getByText('(2,384)')).toBeInTheDocument();
    // 4.6 / 5 = 92% fill on the overlay.
    const overlay = container.querySelector('[style*="width: 92%"]');
    expect(overlay).not.toBeNull();
  });

  it('renders a list item thumbnail and right-aligned meta', () => {
    const { container } = render(
      <WidgetRenderer
        document={{
          version: 1,
          root: {
            type: 'list',
            items: [{ title: 'Keyboard', image: 'https://x/y.png', meta: '$129.00' }],
          },
        }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText('$129.00')).toBeInTheDocument();
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'https://x/y.png');
  });

  it('draws a sparkline for a stat with a trend series', () => {
    const { container } = render(
      <WidgetRenderer
        document={{
          version: 1,
          root: { type: 'stat', label: 'Signups', value: 128, trend: [1, 4, 3, 8, 12] },
        }}
      />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector('polyline')).not.toBeNull();
  });

  it('omits the sparkline when a stat trend has fewer than two points', () => {
    const { container } = render(
      <WidgetRenderer
        document={{
          version: 1,
          root: { type: 'stat', label: 'Signups', value: 128, trend: [5] },
        }}
      />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector('polyline')).toBeNull();
  });
});

describe('Tier-2 delight nodes', () => {
  it.each([
    ['happy', undefined],
    ['thinking', undefined],
    ['celebrating', undefined],
    ['sheepish', undefined],
    ['determined', undefined],
    ['surprised', undefined],
    ['sad', undefined],
    ['love', 'Feeling good today!'],
  ] as const)('renders the %s mood%s', (emotion, message) => {
    renderDoc({ type: 'mood', emotion, message });
    expect(screen.getByRole('img', { name: `Mood: ${emotion}` })).toBeInTheDocument();
    if (message) expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('fires confetti once for a celebrating mood', async () => {
    const { fireConfetti } = await import('@/layers/shared/lib');
    // Reset call count: an earlier parametrized case already rendered a
    // celebrating mood, and the mock persists across tests in this file.
    vi.mocked(fireConfetti).mockClear();
    renderDoc({ type: 'mood', emotion: 'celebrating' });
    expect(fireConfetti).toHaveBeenCalledTimes(1);
  });

  it('renders a board, dispatches an agent action on cell click, and disables unavailable cells', async () => {
    const user = userEvent.setup();
    mockTransport.sendUiAction = vi.fn().mockResolvedValue({ sessionId: 'sess-1' });
    render(
      <WidgetRenderer
        document={{
          version: 1,
          title: 'Tic-tac-toe',
          root: {
            type: 'board',
            label: 'Tic-tac-toe',
            rows: [
              [{ glyph: 'X' }, { glyph: 'O' }, { action: { kind: 'agent', id: 'move-0-2' } }],
              [{}, { glyph: 'X' }, {}],
              [{}, {}, {}],
            ],
          },
        }}
        sessionId="sess-1"
      />,
      { wrapper: Wrapper }
    );

    expect(screen.getByRole('grid', { name: 'Tic-tac-toe' })).toBeInTheDocument();
    const gridCells = screen.getAllByRole('gridcell');
    expect(gridCells).toHaveLength(9);

    const playable = screen.getByRole('button');
    await user.click(playable);
    expect(mockTransport.sendUiAction).toHaveBeenCalledWith('sess-1', {
      actionId: 'move-0-2',
      payload: undefined,
      widgetTitle: 'Tic-tac-toe',
    });
  });

  it('disables a board cell action when no session is present', () => {
    renderDoc({
      type: 'board',
      rows: [[{ glyph: 'X' }, { action: { kind: 'agent', id: 'move-0-1' } }]],
    });
    expect(screen.getByRole('button')).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows the reveal result (reduced-motion mock makes the animation instant)', () => {
    renderDoc({ type: 'reveal', kind: 'coin', result: 'heads', label: 'Coin flip' });
    expect(screen.getByText('Coin flip')).toBeInTheDocument();
    expect(screen.getByText('heads')).toBeInTheDocument();
  });

  it('shows a numeric dice reveal result', () => {
    renderDoc({ type: 'reveal', kind: 'd6', result: '4' });
    expect(screen.getByText('4')).toBeInTheDocument();
  });
});

describe('WidgetFence (fence detection)', () => {
  it('shows a skeleton while the fence is still streaming', () => {
    render(<WidgetFence code={'{ "version": 1, "root":'} isIncomplete />);
    expect(screen.getByLabelText('Loading widget')).toBeInTheDocument();
  });

  it('renders the widget once the fence completes', () => {
    render(
      <WidgetFence
        code={JSON.stringify({ version: 1, root: { type: 'heading', text: 'Done', level: 2 } })}
        isIncomplete={false}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByRole('heading', { name: 'Done' })).toBeInTheDocument();
  });

  it('renders the error card for invalid JSON', () => {
    render(<WidgetFence code={'{ not json'} isIncomplete={false} />);
    expect(screen.getByText("This widget couldn't be rendered")).toBeInTheDocument();
  });
});

describe('WidgetErrorCard (D5)', () => {
  it('reveals the raw JSON on expand', async () => {
    const user = userEvent.setup();
    render(<WidgetErrorCard error="bad thing" raw={'{"oops":true}'} />);
    expect(screen.getByText('bad thing')).toBeInTheDocument();
    expect(screen.queryByText('{"oops":true}')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show raw json/i }));
    expect(screen.getByText('{"oops":true}')).toBeInTheDocument();
  });
});
