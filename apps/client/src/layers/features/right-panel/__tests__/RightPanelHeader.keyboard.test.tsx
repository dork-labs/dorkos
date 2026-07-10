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

  it('exposes exactly one Tab stop: the active tab is tabIndex 0, the rest -1', () => {
    renderStrip('canvas');
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
});
