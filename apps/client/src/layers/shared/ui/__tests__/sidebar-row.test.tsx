/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Pin } from 'lucide-react';
import { SidebarRow } from '../sidebar-row';
import { SIDEBAR_ROW_ATTRIBUTE } from '@/layers/shared/model/interaction/use-roving-focus';

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// ── The viewport ───────────────────────────────────────────────────────────
let phone = false;
function useEmulatedViewport() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const maxWidth = /max-width:\s*(\d+)px/.exec(query);
      return {
        matches: maxWidth === null ? false : phone && 390 <= Number(maxWidth[1]),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
}

afterEach(() => {
  phone = false;
  useEmulatedViewport();
  cleanup();
});

/** The row's own button — the element every assertion here is about. */
function row(): HTMLElement {
  return screen.getByRole('button', { name: /./ });
}

describe('SidebarRow — the row grammar (BC-23)', () => {
  it('draws the session marker only when the row has an owner', () => {
    // The `›` IS the session marker: its absence means "this is the place, not
    // a thread of it". A room row and a session row differ by this one glyph.
    const { container, rerender } = render(<SidebarRow who="Scout" title="fix the flake" />);
    expect(container.textContent).toContain('›');

    rerender(<SidebarRow title="#general" />);
    expect(container.textContent).not.toContain('›');
  });

  it('puts the full `Agent › Title` in the row’s title attribute, however narrow the row is', () => {
    render(<SidebarRow who="Scout" title="fix the flake" />);
    expect(row()).toHaveAttribute('title', 'Scout › fix the flake');
  });
});

describe('SidebarRow — state and chrome', () => {
  it('marks the open row as the current page', () => {
    render(<SidebarRow title="#general" isActive />);
    expect(row()).toHaveAttribute('aria-current', 'page');
  });

  it('bolds an unread row, and stops when it is muted', () => {
    const { rerender } = render(<SidebarRow title="#general" emphasized />);
    expect(row().className).toContain('font-semibold');
    expect(row()).toHaveAttribute('data-row-state', 'emphasized');
    rerender(<SidebarRow title="#general" emphasized muted />);
    expect(row().className).not.toContain('font-semibold');
    expect(row()).toHaveAttribute('data-row-state', 'quiet');
  });

  it('makes an interactive glyph a SIBLING of the row, never a button inside it', () => {
    // A `<button>` inside a `<button>` is invalid HTML that assistive tech announces
    // unpredictably — and it is exactly what happens if a face that opens a profile is handed to
    // the row as glyph content.
    const onGlyph = vi.fn();
    const { container } = render(
      <SidebarRow
        glyph={<span>face</span>}
        glyphAction={{ onClick: onGlyph, label: 'Open Scout’s profile' }}
        title="Scout"
      />
    );
    expect(container.querySelector('button button')).toBeNull();

    const face = screen.getByRole('button', { name: 'Open Scout’s profile' });
    fireEvent.click(face);
    expect(onGlyph).toHaveBeenCalledOnce();
  });

  it('does not let the glyph control also fire the row', () => {
    const onGlyph = vi.fn();
    const onSelect = vi.fn();
    render(
      <SidebarRow
        glyph={<span>face</span>}
        glyphAction={{ onClick: onGlyph, label: 'Open Scout’s profile' }}
        title="Scout"
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Scout’s profile' }));
    expect(onGlyph).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('SidebarRow — the resting hint', () => {
  it('shows its hint in a tooltip and drops the browser title, which would say something else', async () => {
    render(<SidebarRow title="#general" hint="Shipped the fix, tests are green" />);
    expect(row()).not.toHaveAttribute('title');
    // Focus opens a Radix tooltip without the pointer delay, so the content is
    // reachable in jsdom; a pointer resting on the row opens the same one.
    fireEvent.focus(row());
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Shipped the fix, tests are green');
    // Led by the name, so a name the row cut short is still readable in full.
    expect(tip).toHaveTextContent(/^#general/);
  });
});

describe('SidebarRow — the trailing action slot (DOR-1111)', () => {
  /** A menu with one item, so the row really has a context menu to open. */
  const MENU = {
    menuNodes: [{ kind: 'action' as const, id: 'pin', label: 'Pin', icon: Pin, run: vi.fn() }],
    actionsLabel: 'Scout actions',
  };

  /** The trailing action as the row renders it. */
  function action(): HTMLElement {
    return screen.getByRole('button', { name: '3 live sessions' });
  }

  function renderRow(extra: Record<string, unknown> = {}) {
    return render(
      <SidebarRow
        title="a very long agent name that has to truncate"
        trailingAction={{
          content: <span>3 live</span>,
          onClick: vi.fn(),
          label: '3 live sessions',
        }}
        {...MENU}
        {...extra}
      />
    );
  }

  it('renders the control as a SIBLING of the row, never a button inside it', () => {
    // Queried from the rendered DOM rather than reasoned about from the JSX: a `<button>` inside
    // a `<button>` is invalid HTML that assistive tech announces unpredictably, and it is what
    // the trailing slot itself would produce, since that slot renders inside the row's own
    // button.
    const { container } = renderRow();
    expect(container.querySelector('button button')).toBeNull();
    expect(action().closest(`[${SIDEBAR_ROW_ATTRIBUTE}]`)).toBeNull();
  });

  it('does not let the control also fire the row', () => {
    const onTrailing = vi.fn();
    const onSelect = vi.fn();
    render(
      <SidebarRow
        title="Scout"
        onSelect={onSelect}
        trailingAction={{ content: <span>3 live</span>, onClick: onTrailing, label: '3 live' }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '3 live' }));
    expect(onTrailing).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('SidebarRow — the reservation refuses interactive content (DOR-1111)', () => {
  /** The rule the slot cannot express in its types. */
  /**
   * Render a row with the given trailing content and hand back what the GUARD said, and what the
   * DOM ended up looking like.
   */
  function renderContent(content: ReactNode): { complaints: string[]; nested: boolean } {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { container } = render(
        <SidebarRow
          title="Scout"
          trailingAction={{ content, onClick: vi.fn(), label: '3 live sessions' }}
        />
      );
      return {
        complaints: spy.mock.calls
          .map((call) => String(call[0]))
          .filter((message) => message.startsWith('SidebarRow:')),
        nested: container.querySelector('button button') !== null,
      };
    } finally {
      spy.mockRestore();
    }
  }

  it('shouts, and names the row, when a caller’s content brings its own button', () => {
    const { complaints, nested } = renderContent(<button type="button">3 live</button>);
    // The defect really is in the DOM — this is what the guard is for.
    expect(nested).toBe(true);
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toContain('3 live sessions');
  });
});

describe('SidebarRow — the reserved verb line (BC-24, R1)', () => {
  it('lets the verb outrank the preview while the turn is live', () => {
    // The other half of the same rule: a streaming row spends its one line on
    // what is happening now, not on what happened last.
    render(
      <SidebarRow
        title="#general"
        preview="Scout shipped the fix"
        secondLine={<span>Editing RoomRow.tsx…</span>}
        reservesVerbLine
      />
    );
    expect(screen.getByText('Editing RoomRow.tsx…')).toBeInTheDocument();
    expect(screen.queryByText('Scout shipped the fix')).not.toBeInTheDocument();
  });
});

describe('SidebarRow — under a thumb (P4 AC-4)', () => {
  const menu = [{ kind: 'action' as const, id: 'pin', label: 'Pin', icon: Pin, run: vi.fn() }];

  function renderTouchRow(extra: Record<string, unknown> = {}) {
    return render(
      <SidebarRow
        title="Dashboard overhaul"
        menuNodes={menu}
        actionsLabel="Row actions"
        onSelect={vi.fn()}
        {...extra}
      />
    );
  }

  /** The row's own button, found by the attribute the roving hook stamps. */
  const rowButton = () => document.querySelector(`[${SIDEBAR_ROW_ATTRIBUTE}]`) as HTMLElement;

  it('grows the row to 44px and its gutter with it', () => {
    phone = true;
    useEmulatedViewport();
    renderTouchRow();
    expect(rowButton().className).toContain('min-h-11');
    // The gutter has to grow WITH the control it clears — a 44px "⋮" in a 28px
    // gutter lands on the row's own words.
    expect(rowButton().className).toContain('pr-11');
    expect(rowButton().className).not.toContain('min-h-7');
  });
});
