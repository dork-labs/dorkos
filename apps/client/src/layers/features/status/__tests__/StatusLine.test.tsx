/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StatusLine } from '../ui/StatusLine';
import { applyStatusBudget, resolveStatusBudget } from '../model/status-budget';
import type { PromotedStatusItem } from '../model/promoted-items';
import type { StatusBarItemKey } from '../model/status-bar-registry';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Build a promoted item with a labelled node. */
function item(
  key: StatusBarItemKey,
  cluster: 'left' | 'right' = 'right',
  severity = 0
): PromotedStatusItem {
  return { key, cluster, severity, pinned: false, node: <span>{key} content</span> };
}

describe('StatusLine', () => {
  describe('the toolbar container', () => {
    it('renders with its ARIA identity even when no items promoted', () => {
      // The `⋯` is never droppable, so the row itself is always present — there is
      // no state in which the Session panel becomes unreachable.
      render(<StatusLine items={[]} trailing={<button>more</button>} />);
      const toolbar = screen.getByRole('toolbar');
      expect(toolbar).toHaveAttribute('aria-label', 'Session status');
      expect(toolbar).toHaveAttribute('aria-live', 'polite');
      expect(screen.getByRole('button', { name: 'more' })).toBeInTheDocument();
    });

    it('renders every item it is handed', () => {
      render(<StatusLine items={[item('cwd', 'left'), item('model'), item('context')]} />);
      expect(screen.getByText('cwd content')).toBeInTheDocument();
      expect(screen.getByText('model content')).toBeInTheDocument();
      expect(screen.getByText('context content')).toBeInTheDocument();
    });
  });

  describe('never scrolled, never wrapped', () => {
    it('lets both clusters shrink so a mis-sized item truncates instead of clipping', () => {
      // The bug this fixes (DOR-452): the right cluster was `shrink-0` inside an
      // `overflow-hidden` row, so any item wider than the budget predicted was
      // silently clipped and unreachable — worse than the scroller this replaced,
      // which at least advertised the overflow with a fade.
      const { container } = render(
        <StatusLine items={[item('agent', 'left', 1000), item('model')]} />
      );
      const [left, right] = [...container.querySelectorAll('[role="toolbar"] > div')];
      expect(left.className).toContain('min-w-0');
      expect(right.className).toContain('min-w-0');
      expect(right.className).not.toContain('shrink-0');
    });

    it('never lets the reveal anchor be the thing that shrinks', () => {
      // The `⋯` is the one guarantee the line makes: everything it dropped is one
      // tap away. So its `shrink-0` belongs to the line, not to whatever is passed.
      const { container } = render(
        <StatusLine items={[item('model')]} trailing={<button>more</button>} />
      );
      const anchor = container.querySelector('[role="toolbar"] > span')!;
      expect(anchor.className).toContain('shrink-0');
      expect(anchor.querySelector('button')).not.toBeNull();
    });

    it('clips instead of offering a scroller nobody can pan', () => {
      // `touch-action: pan-y` on an ancestor used to block the inner container's
      // horizontal panning, so overflowed items were unreachable on a phone while a
      // fade gradient advertised that they existed. The budget replaces both.
      render(<StatusLine items={[item('model'), item('context')]} />);
      const toolbar = screen.getByRole('toolbar');
      expect(toolbar.className).toContain('overflow-hidden');
      expect(toolbar.className).toContain('whitespace-nowrap');
      expect(toolbar.className).not.toContain('overflow-x-auto');
    });

    it('keeps the Session anchor reachable at the narrowest width', () => {
      // The `⋯` sits outside the budget and outside the clip, so no width can leave
      // the panel — and everything the line dropped — unreachable.
      const promoted: PromotedStatusItem[] = [
        item('agent', 'left', 1000),
        item('cwd', 'left', 5),
        item('git', 'left', 20),
        item('runtime', 'right', 30),
        item('model', 'right', 10),
        item('context', 'right', 90),
        item('connection', 'right', 100),
      ];
      const { items: budgeted, overflow } = applyStatusBudget(promoted, resolveStatusBudget(320));
      render(
        <StatusLine
          items={budgeted}
          trailing={<button aria-label={`Session details, ${overflow} more`}>anchor</button>}
        />
      );

      expect(screen.getByRole('button', { name: 'Session details, 2 more' })).toBeInTheDocument();
      expect(screen.getByTestId('status-item-agent')).toBeInTheDocument();
      expect(screen.queryByTestId('status-item-cwd')).not.toBeInTheDocument();
      expect(screen.queryByTestId('status-item-model')).not.toBeInTheDocument();
    });
  });

  describe('two clusters', () => {
    it('keeps left-cluster items ahead of right-cluster items in the DOM', () => {
      const { container } = render(
        <StatusLine items={[item('agent', 'left'), item('connection', 'right')]} />
      );
      const rendered = [...container.querySelectorAll('[data-testid^="status-item-"]')].map((el) =>
        el.getAttribute('data-testid')
      );
      expect(rendered).toEqual(['status-item-agent', 'status-item-connection']);
    });

    it('puts the trailing anchor after both clusters', () => {
      const { container } = render(
        <StatusLine items={[item('model')]} trailing={<button data-testid="anchor">more</button>} />
      );
      const model = container.querySelector('[data-testid="status-item-model"]')!;
      const anchor = container.querySelector('[data-testid="anchor"]')!;
      expect(model.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('separators', () => {
    it('renders none for a single item', () => {
      const { container } = render(<StatusLine items={[item('model')]} />);
      expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(0);
    });

    it('renders N-1 separators inside one cluster', () => {
      const { container } = render(
        <StatusLine items={[item('runtime'), item('model'), item('context')]} />
      );
      expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(2);
    });

    it('never places one beside the flexible gap between the clusters', () => {
      // One item per cluster: each is first in its own cluster, so neither grows a
      // separator. A middot floating in the gap is what reads as "centered".
      const { container } = render(
        <StatusLine items={[item('cwd', 'left'), item('model', 'right')]} />
      );
      expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(0);
    });

    it('gives the first visible item no leading separator after an earlier item drops out', () => {
      // The bug this replaces: separator placement keyed off registration order, so
      // an item that hid and came back rendered with a leading middot.
      const { container, rerender } = render(
        <StatusLine items={[item('runtime'), item('model'), item('context')]} />
      );
      expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(2);

      rerender(<StatusLine items={[item('model'), item('context')]} />);
      expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(1);

      rerender(<StatusLine items={[item('runtime'), item('model'), item('context')]} />);
      expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(2);
    });

    it('renders the middot character', () => {
      const { container } = render(<StatusLine items={[item('runtime'), item('model')]} />);
      expect(container.querySelector('span[aria-hidden="true"]')?.textContent).toBe('·');
    });
  });
});
