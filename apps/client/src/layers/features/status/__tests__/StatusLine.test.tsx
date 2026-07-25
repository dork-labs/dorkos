/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StatusLine } from '../ui/StatusLine';
import type { PromotedStatusItem } from '../model/promoted-items';
import type { StatusBarItemKey } from '../model/status-bar-registry';

// ResizeObserver is not available in jsdom — provide a minimal stub.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

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
