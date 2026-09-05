/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Pin } from 'lucide-react';
import { SidebarRow } from '../sidebar-row';
import {
  ROW_TITLE_CLASS,
  ROW_TRAILING_CLASS,
  ROW_WHO_CLASS,
} from '@/layers/shared/lib/row-grammar';
import {
  SIDEBAR_ACTIONS_ATTRIBUTE,
  SIDEBAR_ROW_ATTRIBUTE,
  SIDEBAR_TRAILING_ACTION_ATTRIBUTE,
} from '@/layers/shared/model/interaction/use-roving-focus';

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

  it('names the row from titleText when the title is a node', () => {
    render(<SidebarRow who="Scout" title={<em>fix the flake</em>} titleText="fix the flake" />);
    expect(row()).toHaveAttribute('title', 'Scout › fix the flake');
  });

  it('repeats the owner’s name on every one of its rows, on purpose', () => {
    // The same agent with three sessions makes three rows. Structural
    // clustering was rejected: Today's shape would churn as sessions come and
    // go, and the repeated name is the stable thing to scan for.
    render(
      <>
        <SidebarRow who="Scout" title="one" />
        <SidebarRow who="Scout" title="two" />
        <SidebarRow who="Scout" title="three" />
      </>
    );
    expect(screen.getAllByText('Scout')).toHaveLength(3);
  });
});

describe('SidebarRow — the truncation budget (BC-25)', () => {
  it('caps the owner at 42%, flexes the title, and pins the meta slot', () => {
    // The classes ARE the budget — no JavaScript measures anything, which is
    // what makes it deterministic at any width. The computed-style proof at a
    // real 272px lives in the browser spec; this pins the declaration.
    render(<SidebarRow who="Scout" title="fix the flake" trailing={<span>2m</span>} />);
    expect(screen.getByText('Scout').className).toBe(ROW_WHO_CLASS);
    expect(screen.getByText('fix the flake').className).toBe(ROW_TITLE_CLASS);
    expect(screen.getByText('2m').parentElement?.className).toContain(ROW_TRAILING_CLASS);
  });
});

describe('SidebarRow — the second line (BC-24)', () => {
  it('renders no second line for a quiet row', () => {
    render(<SidebarRow title="#general" />);
    expect(screen.queryByText('anything')).not.toBeInTheDocument();
    expect(row().className).toContain('items-center');
  });

  it('renders one when there is a preview', () => {
    render(<SidebarRow title="#general" preview="Scout shipped the fix" />);
    expect(screen.getByText('Scout shipped the fix')).toBeInTheDocument();
    expect(row().className).toContain('items-start');
  });

  it('renders one when the row reserves a verb line, even with no preview', () => {
    render(
      <SidebarRow title="#general" reservesVerbLine secondLine={<span>editing RoomRow.tsx</span>} />
    );
    expect(screen.getByText('editing RoomRow.tsx')).toBeInTheDocument();
  });

  it('does not render a supplied second line the row has not earned', () => {
    // The prop alone is not the trigger. Height differences carry meaning, so a
    // row grows only when there is a live verb or a preview behind it.
    render(<SidebarRow title="#general" secondLine={<span>should not show</span>} />);
    expect(screen.queryByText('should not show')).not.toBeInTheDocument();
  });

  it('treats a whitespace-only preview as no preview', () => {
    render(<SidebarRow title="#general" preview="   " />);
    expect(row().className).toContain('items-center');
  });
});

describe('SidebarRow — state and chrome', () => {
  it('marks the open row as the current page', () => {
    render(<SidebarRow title="#general" isActive />);
    expect(row()).toHaveAttribute('aria-current', 'page');
  });

  it('separates by tint rather than by a line', () => {
    // `--muted` is banned inside the sidebar: it is lighter than the panel in
    // light mode and darker in dark, so a row tinted with it would separate in
    // opposite directions between themes (spec R1). The whole ramp is
    // `--sidebar-accent`, and no row carries a border.
    render(<SidebarRow title="#general" isActive />);
    expect(row().className).toContain('bg-sidebar-accent');
    expect(row().className).not.toMatch(/\bbg-muted|\bborder-b|\bborder-t/);
  });

  it('bolds an unread row, and stops when it is muted', () => {
    const { rerender } = render(<SidebarRow title="#general" emphasized />);
    expect(row().className).toContain('font-medium');
    rerender(<SidebarRow title="#general" emphasized muted />);
    expect(row().className).not.toContain('font-medium');
  });

  // The top of the ladder: open beats unread. A row you are looking at has
  // nothing left to ask for, so it wears the open treatment and not the bold.
  it('leaves an open row on the open treatment even when it is also unread', () => {
    render(<SidebarRow title="#general" isActive emphasized />);
    expect(row().className).toContain('bg-sidebar-accent');
    expect(row().className).not.toContain('font-medium');
  });

  it('swaps itself for an inline editor and withdraws the ⋮ while it is up', () => {
    // The menu that opened the editor must not offer a second door back into
    // itself — and the row underneath is gone, so there is nothing to act on.
    render(
      <SidebarRow
        title="#general"
        menuNodes={[{ kind: 'action', id: 'pin', label: 'Pin', icon: Pin, run: vi.fn() }]}
        actionsLabel="#general actions"
        editor={<input aria-label="Rename #general" />}
      />
    );
    expect(screen.getByLabelText('Rename #general')).toBeInTheDocument();
    expect(screen.queryByLabelText('#general actions')).not.toBeInTheDocument();
  });

  it('makes an interactive glyph a SIBLING of the row, never a button inside it', () => {
    // A `<button>` inside a `<button>` is invalid HTML that assistive tech
    // announces unpredictably — and it is exactly what happens if a face that
    // opens a profile is handed to the row as glyph content. The control is an
    // overlay on the glyph's square instead: same target, one level out.
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

  it('withdraws the glyph control while an inline editor is up', () => {
    render(
      <SidebarRow
        glyph={<span>face</span>}
        glyphAction={{ onClick: vi.fn(), label: 'Open Scout’s profile' }}
        title="Scout"
        editor={<input aria-label="Rename Scout" />}
      />
    );
    expect(screen.queryByRole('button', { name: 'Open Scout’s profile' })).not.toBeInTheDocument();
  });

  it('opens what it points at', () => {
    const onSelect = vi.fn();
    render(<SidebarRow title="#general" onSelect={onSelect} />);
    fireEvent.click(row());
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe('SidebarRow — the trailing action slot (DOR-1111)', () => {
  /** A menu with one item, so the row really has a context menu to open. */
  const MENU = {
    menuNodes: [{ kind: 'action' as const, id: 'pin', label: 'Pin', icon: Pin, run: vi.fn() }],
    actionsLabel: 'Scout actions',
  };

  /** Drag bindings shaped like dnd-kit's, carrying a transform we can look for. */
  const DRAGGED = {
    setNodeRef: () => {},
    handleProps: {},
    style: { transform: 'translate3d(0px, 60px, 0px)' },
    isDragging: true,
    isOver: false,
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
    // Queried from the rendered DOM rather than reasoned about from the JSX: a
    // `<button>` inside a `<button>` is invalid HTML that assistive tech
    // announces unpredictably, and it is what the trailing slot itself would
    // produce, since that slot renders inside the row's own button.
    const { container } = renderRow();
    expect(container.querySelector('button button')).toBeNull();
    expect(action().closest(`[${SIDEBAR_ROW_ATTRIBUTE}]`)).toBeNull();
  });

  it('rides the drag transform with the row', () => {
    // The defect this slot replaces: mounted on `expansion`, the satellite was
    // a sibling of the drag wrapper, so it was positioned against the list item
    // and stayed put while the row moved 60px down under it — floating at full
    // opacity over whichever row took the slot. Asserted as containment,
    // because jsdom computes no layout; the browser spec measures the pixels.
    const { container } = renderRow({ drag: DRAGGED });
    const dragged = container.querySelector<HTMLElement>('[style*="translate3d"]');
    expect(dragged).not.toBeNull();
    expect(dragged?.contains(action())).toBe(true);
  });

  it('comes before the ⋮ in tab order', () => {
    // Both are satellites the roving-focus hook stamps `-1`, so "tab order"
    // here is DOM order — which is what decides the sequence a reader walks
    // and where a screen reader announces the control relative to the menu.
    const { container } = renderRow();
    const kebab = container.querySelector<HTMLElement>(`[${SIDEBAR_ACTIONS_ATTRIBUTE}]`);
    expect(kebab).not.toBeNull();
    expect(
      action().compareDocumentPosition(kebab!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('sits inside the row’s own menu surface, so right-clicking it opens the row’s menu', async () => {
    // Outside the surface — which is where the `expansion` escape hatch put it
    // — a right-click on the control opened no menu at all, and the operator
    // got the browser's instead.
    renderRow();
    fireEvent.contextMenu(action());
    expect(await screen.findByRole('menuitem', { name: 'Pin' })).toBeInTheDocument();
  });

  it('holds the control’s own width open in the trailing slot', () => {
    // The reservation is what makes a long title ellipsize BEFORE the control
    // rather than sliding under it, and the row owns it so no call site can get
    // the two out of alignment. Invisible, not hidden: it still takes up the
    // line. And `aria-hidden`, so the control is not announced twice.
    const { container } = renderRow();
    const reservation = container.querySelector<HTMLElement>(
      `[${SIDEBAR_ROW_ATTRIBUTE}] .invisible`
    );
    expect(reservation?.textContent).toBe('3 live');
    expect(reservation).toHaveAttribute('aria-hidden');
    expect(screen.getAllByText('3 live')).toHaveLength(2);
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

  it('withdraws the control while an inline editor is up', () => {
    // Same rule the glyph control follows: the row it belongs to is gone, so a
    // control parked over where the row used to be has nothing to act on.
    renderRow({ editor: <input aria-label="Rename Scout" /> });
    expect(screen.queryByRole('button', { name: '3 live sessions' })).not.toBeInTheDocument();
  });

  it('marks the control so the roving-focus hook can reach it', () => {
    const { container } = renderRow();
    expect(container.querySelector(`[${SIDEBAR_TRAILING_ACTION_ATTRIBUTE}]`)).toBe(action());
  });

  it('names the reservation, so a caller’s spec can tell the two copies apart', () => {
    // Without a mark of its own, `getByText('3 live')` resolves twice and every
    // consumer spec throws a strict-mode violation on a row that is working
    // perfectly.
    const { container } = renderRow();
    const reservation = container.querySelector<HTMLElement>(
      '[data-slot="sidebar-row-trailing-reservation"]'
    );
    expect(reservation?.textContent).toBe('3 live');
    expect(reservation?.contains(action())).toBe(false);
  });
});

describe('SidebarRow — the reservation refuses interactive content (DOR-1111)', () => {
  /**
   * The rule the slot cannot express in its types.
   *
   * `content` is drawn twice, and the invisible copy sits INSIDE the row's own
   * `<button>`. So a caller whose chip is a link, or is wrapped in a tooltip
   * trigger, ships a button nested in a button on every row at once — the exact
   * defect `trailingAction` exists to prevent, arriving through the one door the
   * slot leaves open.
   *
   * The structural test above cannot see this: it renders its own fixture
   * content, so `querySelector('button button')` only ever reports on what the
   * TEST passed. This asks the question a caller can actually get wrong.
   */
  /**
   * Render a row with the given trailing content and hand back what the GUARD
   * said, and what the DOM ended up looking like.
   *
   * Filtered to this component's own messages, and restored in a `finally`.
   * React 19 emits its own nested-`<button>` warning down the same channel, so
   * counting every `console.error` would both mistake React's complaint for the
   * guard's and, on a failing assertion, leave the spy installed to poison the
   * next test.
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

  it('catches a link too, which React’s own warning does not', () => {
    // "Interactive" is every focusable, not the one tag that prompted the rule.
    // React only polices a handful of nesting pairs and `<a>` inside `<button>`
    // is not one of them, so without this guard an anchored chip would ship a
    // focusable inside the row button with nothing said at all.
    const { complaints } = renderContent(<a href="/team">3 live</a>);
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toContain('<a>');
  });

  it('says nothing about content that is only ever drawn', () => {
    // The other half of a check that discriminates: a guard that fires on
    // everything is a guard nobody reads.
    const { complaints, nested } = renderContent(<span>3 live</span>);
    expect(complaints).toEqual([]);
    expect(nested).toBe(false);
  });
});

describe('SidebarRow — the reserved verb line (BC-24, R1)', () => {
  /** The second line's own element, present or not. */
  function secondLine(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[data-slot="sidebar-row-second-line"]');
  }

  it('holds the line open while the verb inside it is silent', () => {
    // The row's HEIGHT comes from lifecycle (`reservesVerbLine`) and its WORDS
    // come from activity, and the two arrive on different clocks. A tool
    // reading that lapses for a beat mid-turn must not collapse the row and
    // grow it back under the pointer — which is what happened while the line
    // rendered only when it had something in it.
    const { container } = render(
      <SidebarRow title="#general" reservesVerbLine secondLine={null} />
    );
    const line = secondLine(container);
    expect(line).not.toBeNull();
    expect(line?.textContent).toBe('');
    // And the reservation is a real height rather than an empty inline box
    // that collapses to nothing.
    expect(line?.className).toContain('min-h-4');
    expect(line?.className).toContain('block');
    expect(row().className).toContain('items-start');
  });

  it('still refuses the line to a row that reserved nothing', () => {
    const { container } = render(<SidebarRow title="#general" />);
    expect(secondLine(container)).toBeNull();
  });

  it('keeps the preview of an idle row that was handed a silent verb node', () => {
    // The shape every session row has once the sidebar is wired: a verb node is
    // passed whether or not the session is live, and an idle one renders null.
    // A null-rendering component is still an ELEMENT, so choosing between the
    // two with `??` fell back only on `undefined` and silently ate the preview
    // of every idle row in Today.
    const SilentVerb = () => null;
    const { container } = render(
      <SidebarRow
        title="#general"
        preview="Scout shipped the fix"
        secondLine={<SilentVerb />}
        reservesVerbLine={false}
      />
    );
    expect(screen.getByText('Scout shipped the fix')).toBeInTheDocument();
    expect(secondLine(container)?.textContent).toBe('Scout shipped the fix');
  });

  it('keeps the preview of a busy room, which reserves a line but has no verb node', () => {
    // The shape `library-rows.ts` and `select-today-items.ts` already ship:
    // `reservesVerbLine: (room.working ?? 0) > 0` on a row that carries a
    // preview and no verb node at all. Deciding the line's CONTENT from
    // `reservesVerbLine` — rather than only its EXISTENCE — emptied every one
    // of them.
    const { container } = render(
      <SidebarRow title="#general" reservesVerbLine preview="Ana: ship it" />
    );
    expect(screen.getByText('Ana: ship it')).toBeInTheDocument();
    expect(secondLine(container)?.textContent).toBe('Ana: ship it');
  });

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

  it('keeps 28px under a pointer, which is the density §11 asks for', () => {
    renderTouchRow();
    expect(rowButton().className).toContain('min-h-7');
    expect(rowButton().className).toContain('pr-7');
  });

  it('draws no 18px face overlay on touch, because 18px is half a target', () => {
    const onGlyph = vi.fn();
    phone = true;
    useEmulatedViewport();
    renderTouchRow({
      glyph: <span>G</span>,
      glyphAction: { onClick: onGlyph, label: 'Open Scout’s profile' },
    });
    expect(screen.queryByRole('button', { name: 'Open Scout’s profile' })).toBeNull();
  });

  it('does draw it under a pointer, where 18px is a mouse target', () => {
    // The pair — without it the absence above would also pass against a row
    // that had lost the control entirely.
    const onGlyph = vi.fn();
    renderTouchRow({
      glyph: <span>G</span>,
      glyphAction: { onClick: onGlyph, label: 'Open Scout’s profile' },
    });
    const control = screen.getByRole('button', { name: 'Open Scout’s profile' });
    fireEvent.click(control);
    expect(onGlyph).toHaveBeenCalledTimes(1);
  });

  it('draws no trailing satellite on touch, and holds no width open for one', () => {
    phone = true;
    useEmulatedViewport();
    renderTouchRow({
      trailingAction: { content: <span>3 live</span>, onClick: vi.fn(), label: '3 live sessions' },
    });
    expect(screen.queryByRole('button', { name: '3 live sessions' })).toBeNull();
    // A reservation for a control that is not drawn is a title truncated for
    // nothing — so it goes with it.
    expect(document.querySelector('[data-slot="sidebar-row-trailing-reservation"]')).toBeNull();
  });

  it('does draw it under a pointer, reservation and all', () => {
    renderTouchRow({
      trailingAction: { content: <span>3 live</span>, onClick: vi.fn(), label: '3 live sessions' },
    });
    expect(screen.getByRole('button', { name: '3 live sessions' })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sidebar-row-trailing-reservation"]')).not.toBeNull();
    expect(document.querySelector(`[${SIDEBAR_TRAILING_ACTION_ATTRIBUTE}]`)?.className).toContain(
      'right-7'
    );
  });
});
