/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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
