/**
 * @vitest-environment jsdom
 *
 * Keyboard-accessibility coverage for the right-panel tab strip. Unlike the
 * sibling `RightPanelHeader.test.tsx` (which mocks the store for render checks),
 * these tests drive the REAL app store so that automatic activation produces
 * genuine re-renders — the roving tabindex and focus must follow selection.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@/layers/shared/ui';
import { useAppStore, type RightPanelContribution } from '@/layers/shared/model';
import { RightPanelHeader, RIGHT_PANEL_PANEL_ID } from '../ui/RightPanelHeader';

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
  // Radix Tooltip uses ResizeObserver internally — stub it for jsdom.
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const MockIcon = () => null;

function makeContribution(id: string, title: string): RightPanelContribution {
  return {
    id,
    title,
    icon: MockIcon as unknown as RightPanelContribution['icon'],
    component: () => <div>Content {id}</div>,
  };
}

const CONTRIBUTIONS = [
  makeContribution('agent', 'Agent'),
  makeContribution('canvas', 'Canvas'),
  makeContribution('terminal', 'Terminal'),
];

function renderStrip(initial = 'agent') {
  useAppStore.setState({ activeRightPanelTab: initial });
  return render(
    <TooltipProvider>
      <button type="button">before</button>
      <RightPanelHeader contributions={CONTRIBUTIONS} />
    </TooltipProvider>
  );
}

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name });
}

describe('RightPanelHeader — keyboard accessibility (WAI-ARIA Tabs)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ activeRightPanelTab: null, rightPanelLayoutKey: null });
  });
  afterEach(cleanup);

  it('exposes exactly one Tab stop before entry too: the tablist is the stop, every tab is -1', () => {
    // The property the roving-focus group protects isn't just "the active tab
    // ends up tabIndex 0 after Tab" (the case below) — it's "the strip never
    // contributes more than one stop, at any point in its lifecycle". Radix
    // puts the stop on the tablist container itself until real focus arrives,
    // with every trigger at -1; assert that render-time shape directly rather
    // than only the post-entry snapshot.
    renderStrip('canvas');

    expect(screen.getByRole('tablist')).toHaveAttribute('tabindex', '0');
    expect(tab('Agent')).toHaveAttribute('tabindex', '-1');
    expect(tab('Canvas')).toHaveAttribute('tabindex', '-1');
    expect(tab('Terminal')).toHaveAttribute('tabindex', '-1');
  });

  it('exposes exactly one Tab stop after entry: the active tab is tabIndex 0, the rest -1', async () => {
    // The roving-focus group hands off its tab stop to the active item the
    // first time real focus enters it (see the "Tab enters the strip" case
    // below) rather than computing it eagerly on render — the tablist itself
    // is the entry point until then. Check the invariant post-entry, the way
    // a keyboard user actually reaches the strip.
    const user = userEvent.setup();
    renderStrip('canvas');

    screen.getByRole('button', { name: 'before' }).focus();
    await user.tab();

    expect(tab('Agent')).toHaveAttribute('tabindex', '-1');
    expect(tab('Canvas')).toHaveAttribute('tabindex', '0');
    expect(tab('Terminal')).toHaveAttribute('tabindex', '-1');
  });

  it('Tab enters the strip once (lands on active), then leaves it', async () => {
    const user = userEvent.setup();
    renderStrip('canvas');

    screen.getByRole('button', { name: 'before' }).focus();
    await user.tab();
    expect(tab('Canvas')).toHaveFocus();

    // Next Tab leaves the tablist — it reaches the panel close button.
    await user.tab();
    expect(tab('Canvas')).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close panel' })).toHaveFocus();
  });

  it('ArrowRight moves focus and activates, wrapping at the end', async () => {
    const user = userEvent.setup();
    renderStrip('agent');
    tab('Agent').focus();

    await user.keyboard('{ArrowRight}');
    expect(tab('Canvas')).toHaveFocus();
    expect(tab('Canvas')).toHaveAttribute('aria-selected', 'true');
    expect(useAppStore.getState().activeRightPanelTab).toBe('canvas');

    await user.keyboard('{ArrowRight}');
    expect(tab('Terminal')).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(tab('Agent')).toHaveFocus();
  });

  it('ArrowLeft wraps at the start', async () => {
    const user = userEvent.setup();
    renderStrip('agent');
    tab('Agent').focus();

    await user.keyboard('{ArrowLeft}');
    expect(tab('Terminal')).toHaveFocus();
    expect(tab('Terminal')).toHaveAttribute('aria-selected', 'true');
  });

  it('Home and End jump to the first and last tabs', async () => {
    const user = userEvent.setup();
    renderStrip('canvas');
    tab('Canvas').focus();

    await user.keyboard('{End}');
    expect(tab('Terminal')).toHaveFocus();

    await user.keyboard('{Home}');
    expect(tab('Agent')).toHaveFocus();
  });

  it('does not advertise Delete (right-panel tabs are not closable) and wires aria-controls', () => {
    renderStrip('agent');
    expect(tab('Agent')).not.toHaveAttribute('aria-keyshortcuts');
    expect(tab('Agent')).toHaveAttribute('aria-controls', RIGHT_PANEL_PANEL_ID);
    expect(tab('Canvas')).not.toHaveAttribute('aria-controls');
  });

  it('never fires the "uncontrolled to controlled" warning across the real null → id lifecycle', () => {
    // The store starts every session at `activeRightPanelTab: null` and the
    // container's auto-select effect then picks a default tab on the next
    // render (RightPanelContainer.tsx) — the exact lifecycle every real
    // mount goes through, and the one the other tests here skip by always
    // calling `renderStrip('canvas')` with a value already set. `value={x ??
    // undefined}` mounts Tabs uncontrolled at `null` and flips it controlled
    // the moment a real id lands, which is what Radix's dev warning exists
    // to catch — assert it stays silent through that exact transition.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      useAppStore.setState({ activeRightPanelTab: null });
      const { rerender } = render(
        <TooltipProvider>
          <RightPanelHeader contributions={CONTRIBUTIONS} />
        </TooltipProvider>
      );

      useAppStore.setState({ activeRightPanelTab: 'canvas' });
      rerender(
        <TooltipProvider>
          <RightPanelHeader contributions={CONTRIBUTIONS} />
        </TooltipProvider>
      );

      const uncontrolledWarning = errorSpy.mock.calls.some((call) =>
        String(call[0]).includes('uncontrolled to controlled')
      );
      expect(uncontrolledWarning).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
