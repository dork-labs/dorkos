/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

afterEach(cleanup);
import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import { WidgetRenderer } from '../ui/WidgetRenderer';
import { WidgetFence } from '../ui/WidgetFence';
import { WidgetErrorCard } from '../ui/WidgetErrorCard';

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
  render(<WidgetRenderer document={{ version: 1, title, root }} />);
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

  it('uses the document title as the region label', () => {
    renderDoc({ type: 'divider' }, 'My Widget');
    expect(screen.getByRole('region', { name: 'My Widget' })).toBeInTheDocument();
  });
});

describe('widget actions', () => {
  it('opens a url action in a new tab', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderDoc({
      type: 'button',
      label: 'Open docs',
      action: { kind: 'url', href: 'https://dorkos.ai' },
    });
    await user.click(screen.getByRole('button', { name: 'Open docs' }));
    expect(open).toHaveBeenCalledWith('https://dorkos.ai', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('disables agent actions until the interaction channel ships (PR E)', () => {
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
      />
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
