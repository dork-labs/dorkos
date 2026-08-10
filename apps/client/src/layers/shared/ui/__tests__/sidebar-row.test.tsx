/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pin } from 'lucide-react';
import { SidebarRow, WELCOME_BACK_GLOW } from '../sidebar-row';
import {
  ROW_TITLE_CLASS,
  ROW_TRAILING_CLASS,
  ROW_WHO_CLASS,
} from '@/layers/shared/lib/row-grammar';

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => cleanup());

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
});

describe('SidebarRow — the welcome-back glow (BC-49)', () => {
  it('glows for a row whose work finished while you were away', () => {
    render(<SidebarRow title="#general" welcomeBack />);
    expect(row().className).toContain(WELCOME_BACK_GLOW);
  });

  it('leaves every other row alone', () => {
    render(<SidebarRow title="#general" />);
    expect(row().className).not.toContain('welcome-back-glow');
  });

  it('plays once, and cannot be re-armed by a model rebuild', () => {
    // "On first paint" is the whole moment. A row that could be re-armed by a
    // prop flipping back and forth is a row that pulses at you every time the
    // sidebar model rebuilds — and it rebuilds on every unread, every rename
    // and every new session.
    const { rerender } = render(<SidebarRow title="#general" welcomeBack={false} />);
    expect(row().className).not.toContain('welcome-back-glow');

    rerender(<SidebarRow title="#general" welcomeBack />);
    expect(row().className).not.toContain('welcome-back-glow');
  });

  it('renders nothing at all under a reduced-motion preference', () => {
    // The gate is `motion-safe:`, so the utility is never applied rather than
    // applied-and-suppressed. Nothing is lost: the beat is an announcement
    // about the past, not a fact the row would otherwise be missing.
    render(<SidebarRow title="#general" welcomeBack />);
    expect(WELCOME_BACK_GLOW.startsWith('motion-safe:')).toBe(true);
    expect(row().className).not.toMatch(/(^|\s)animate-welcome-back-glow(\s|$)/);
  });

  it('names a utility that actually exists in the stylesheet', () => {
    // Not a formality. ~20 call sites in this repo wore `animate-tasks` for
    // months while no keyframe by that name existed, and the pulse they were
    // asking for was silently dead CSS the whole time (see `index.css`). A
    // Tailwind class that matches no utility is not an error anywhere else in
    // the toolchain, so this is the only place the typo can be caught.
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../../index.css'),
      'utf8'
    );
    const utility = WELCOME_BACK_GLOW.replace('motion-safe:', '');
    expect(css).toContain(`@utility ${utility} {`);
    expect(css).toContain('@keyframes welcome-back-glow {');
    // …and that the utility really drives those keyframes, rather than
    // declaring a name and animating something else.
    const block = css.slice(css.indexOf(`@utility ${utility} {`));
    expect(block.slice(0, block.indexOf('}'))).toMatch(/animation:\s*welcome-back-glow\b/);
  });
});
