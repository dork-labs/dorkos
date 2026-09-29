// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { PaneResizeHandle, type PaneResizeHandleProps } from '../pane-resize-handle';

// The browser build: the package's `node` export, which Vitest resolves, skips
// the layout effects that wire the keyboard up.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const pkg = createRequire(import.meta.url).resolve('react-resizable-panels/package.json');
  return vi.importActual(join(dirname(pkg), 'dist/react-resizable-panels.browser.development.js'));
});

afterEach(cleanup);

function renderHandle(props: Partial<PaneResizeHandleProps> = {}) {
  return render(
    <PanelGroup direction="horizontal">
      <Panel id="a" order={1} defaultSize={60}>
        a
      </Panel>
      <PaneResizeHandle aria-label="Resize b" {...props} />
      <Panel id="b" order={2} defaultSize={40}>
        b
      </Panel>
    </PanelGroup>
  );
}

function line() {
  return screen
    .getByRole('separator', { name: 'Resize b' })
    .querySelector('[data-slot="pane-resize-line"]')!;
}

describe('PaneResizeHandle', () => {
  it('is a named, focusable separator', () => {
    renderHandle();

    expect(screen.getByRole('separator', { name: 'Resize b' })).toHaveAttribute('tabindex', '0');
  });

  it('warms on hover, and lights at once on keyboard focus', () => {
    renderHandle();

    // Hover eases in; focus must not — a reader tabbing past would never see
    // an indicator that takes half a second to appear.
    expect(line()).toHaveClass('group-hover:bg-ring/50', 'transition-colors', 'duration-500');
    expect(line()).toHaveClass(
      'group-focus-visible:bg-ring',
      'group-focus-visible:transition-none'
    );
  });

  it('leaves the tab order, and draws no hover, when it cannot move', () => {
    renderHandle({ disabled: true });

    const separator = screen.getByRole('separator', { name: 'Resize b' });
    expect(separator).toHaveAttribute('tabindex', '-1');
    expect(separator).toHaveAttribute('aria-disabled', 'true');
    expect(line()).not.toHaveClass('group-hover:bg-ring/50');
    expect(line()).not.toHaveClass('group-focus-visible:bg-ring');
  });

  it('reports the end of a keyboard resize, and nothing else', () => {
    const onResizeEnd = vi.fn();
    renderHandle({ onResizeEnd });
    const separator = screen.getByRole('separator', { name: 'Resize b' });

    fireEvent.keyDown(separator, { key: 'Tab' });
    expect(onResizeEnd).not.toHaveBeenCalled();

    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });

  it('reports nothing from a disabled handle', () => {
    const onResizeEnd = vi.fn();
    renderHandle({ disabled: true, onResizeEnd });

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize b' }), { key: 'ArrowLeft' });
    expect(onResizeEnd).not.toHaveBeenCalled();
  });
});
