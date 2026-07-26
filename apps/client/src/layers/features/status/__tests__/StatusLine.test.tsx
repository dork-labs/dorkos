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
  severity = 0,
  rigid = false
): PromotedStatusItem {
  return { key, cluster, severity, pinned: false, rigid, node: <span>{key} content</span> };
}

/** The wrapper the row draws around one item — where the shrink decision lands. */
function wrapper(key: StatusBarItemKey): HTMLElement {
  return screen.getByTestId(`status-item-${key}`);
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

  describe('numbers keep their pixels; names give them up', () => {
    it('lets a name-bearing item be squeezed, so its value can truncate', () => {
      render(<StatusLine items={[item('permission')]} />);
      expect(wrapper('permission').className).toContain('min-w-10');
      expect(wrapper('permission').className).not.toContain('shrink-0');
    });

    it('refuses to squeeze an item whose value is a number', () => {
      // `88%` truncated to `8…` is not the same fact in fewer letters, it is a
      // different number — so the row must not be able to ask (DOR-461 review).
      render(<StatusLine items={[item('context', 'right', 90, true)]} />);
      expect(wrapper('context').className).toContain('shrink-0');
      expect(wrapper('context').className).not.toContain('min-w-10');
    });

    it('applies the decision per item, not per row', () => {
      render(<StatusLine items={[item('context', 'right', 90, true), item('connection')]} />);
      expect(wrapper('context').className).toContain('shrink-0');
      expect(wrapper('connection').className).toContain('min-w-10');
    });

    it('floors a shrinkable item at the width of what cannot shrink inside it', () => {
      // Squeezed below its separator and glyph, an item renders ~23px of content
      // in a 0px box and paints into its neighbour — the same defect from the
      // other end (DOR-461 review).
      render(<StatusLine items={[item('model'), item('connection')]} />);
      expect(wrapper('model').className).toContain('min-w-10');
      expect(wrapper('model').className).not.toContain('min-w-0');
    });
  });

  describe('the least urgent item pays first', () => {
    it('gives the loudest item the smallest share of a deficit', () => {
      // Flexbox's default is "everyone at once, in proportion to width", which took
      // the pixels back from the most urgent thing on the row — the budget's own
      // ordering, inverted at the last step (DOR-461 review).
      render(
        <StatusLine items={[item('connection', 'right', 100), item('permission', 'right', 70)]} />
      );
      const loudest = Number(wrapper('connection').style.flexShrink);
      const quieter = Number(wrapper('permission').style.flexShrink);
      expect(loudest).toBeGreaterThan(0);
      expect(quieter).toBeGreaterThan(loudest);
    });

    it('ranks within a cluster, so the same item can pay first or last', () => {
      const { unmount } = render(
        <StatusLine items={[item('model', 'right', 10), item('cwd', 'right', 5)]} />
      );
      expect(Number(wrapper('model').style.flexShrink)).toBeLessThan(
        Number(wrapper('cwd').style.flexShrink)
      );
      unmount();

      render(<StatusLine items={[item('model', 'right', 10), item('connection', 'right', 100)]} />);
      expect(Number(wrapper('model').style.flexShrink)).toBeGreaterThan(
        Number(wrapper('connection').style.flexShrink)
      );
    });

    it('never asks a rigid item to pay', () => {
      render(
        <StatusLine
          items={[item('context', 'right', 90, true), item('connection', 'right', 100)]}
        />
      );
      expect(wrapper('context').style.flexShrink).toBe('');
      expect(wrapper('context').className).toContain('shrink-0');
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
