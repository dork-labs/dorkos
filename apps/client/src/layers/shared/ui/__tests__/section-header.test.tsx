/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Hash, Pencil } from 'lucide-react';
import { SectionHeader } from '../section-header';
import type { SidebarMenuNode } from '../sidebar-menu-node';

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => cleanup());

const menu: SidebarMenuNode[] = [
  { kind: 'action', id: 'rename', label: 'Rename', icon: Pencil, opensInput: true, run: vi.fn() },
];

describe('SectionHeader', () => {
  it('is a heading containing the toggle, at the level the section sits at (R2)', () => {
    // A screen reader's heading list is the fastest map of this sidebar there
    // is: sections are <h3>, a group inside Agents is an <h4>.
    const { rerender } = render(
      <SectionHeader label="Channels" collapsed={false} onToggle={vi.fn()} />
    );
    expect(screen.getByRole('heading', { level: 3, name: /Channels/ })).toBeInTheDocument();

    rerender(<SectionHeader level={4} label="Clients" collapsed={false} onToggle={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 4, name: /Clients/ })).toBeInTheDocument();
  });

  it('carries aria-expanded and aria-controls on the toggle (BC-29)', () => {
    render(
      <SectionHeader
        label="Channels"
        collapsed={false}
        onToggle={vi.fn()}
        controlsId="sidebar-section-channels"
      />
    );
    const toggle = screen.getByRole('button', { name: 'Channels' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'sidebar-section-channels');
  });

  it('flips aria-expanded when collapsed', () => {
    render(<SectionHeader label="Channels" collapsed onToggle={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Channels' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('toggles this section from a plain click (BC-29)', () => {
    const onToggle = vi.fn();
    render(<SectionHeader label="Channels" collapsed={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }));
    expect(onToggle).toHaveBeenCalledWith({ all: false });
  });

  it('toggles EVERY section from an Alt/Option-click, and this one from neither (BC-30)', () => {
    const onToggle = vi.fn();
    const onToggleAll = vi.fn();
    render(
      <SectionHeader
        label="Channels"
        collapsed={false}
        onToggle={onToggle}
        onToggleAll={onToggleAll}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }), { altKey: true });
    expect(onToggleAll).toHaveBeenCalledOnce();
    // The one-section toggle must NOT also fire: folding everything and then
    // unfolding this one is not what Alt-click means.
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('falls back to toggling this section when no fold-all handler is supplied', () => {
    const onToggle = vi.fn();
    render(<SectionHeader label="Channels" collapsed={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }), { altKey: true });
    expect(onToggle).toHaveBeenCalledWith({ all: false });
  });

  it('morphs the section’s icon into the collapse chevron on hover and on focus', () => {
    // One slot, two jobs: at rest the header says what the section IS; the
    // moment you reach for it, it says what pressing it will DO. Both marks sit
    // in the same box so nothing shifts (design-decisions §11). jsdom computes
    // no hover, so the declaration is the assertion.
    const { container } = render(
      <SectionHeader label="Channels" icon={Hash} collapsed={false} onToggle={vi.fn()} />
    );
    const marks = container.querySelectorAll('svg');
    expect(marks).toHaveLength(2);
    expect(marks[0]?.getAttribute('class')).toContain('group-hover/section-toggle:opacity-0');
    expect(marks[1]?.getAttribute('class')).toContain('group-hover/section-toggle:opacity-100');
    expect(marks[1]?.getAttribute('class')).toContain(
      'group-focus-visible/section-toggle:opacity-100'
    );
  });

  it('renders a section label in sentence case, with no ALL-CAPS transform', () => {
    render(<SectionHeader label="Direct messages" collapsed={false} onToggle={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'Direct messages' });
    expect(toggle.className).not.toContain('uppercase');
    expect(toggle.className).not.toContain('tracking-wider');
  });

  it('renders a section that cannot collapse as a plain label carrying the same menus', () => {
    render(<SectionHeader label="Pinned" nodes={menu} />);
    expect(screen.queryByRole('button', { name: 'Pinned' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /Pinned/ })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByLabelText('Pinned section actions'));
    fireEvent.click(screen.getByLabelText('Pinned section actions'));
    expect(screen.getByRole('menuitem', { name: 'Rename…' })).toBeInTheDocument();
  });

  it('draws no ⋮ at all for a section with no menu', () => {
    render(<SectionHeader label="Pinned" />);
    expect(screen.queryByLabelText('Pinned section actions')).not.toBeInTheDocument();
  });

  it('swaps the label for an inline editor and withdraws the ⋮ while it is up', () => {
    render(
      <SectionHeader
        label="Clients"
        nodes={menu}
        collapsed={false}
        onToggle={vi.fn()}
        editor={<input aria-label="Group name" />}
      />
    );
    expect(screen.getByLabelText('Group name')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clients' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Clients section actions')).not.toBeInTheDocument();
  });

  it('renders a collapsed section’s rollup in the trailing slot', () => {
    render(
      <SectionHeader
        label="Channels"
        collapsed
        onToggle={vi.fn()}
        trailing={<span>3 unread</span>}
      />
    );
    expect(screen.getByText('3 unread')).toBeInTheDocument();
  });

  // A folded section may not lose its `activity` tier (BC-31), and that tier is
  // a bold label and nothing else — no badge, no dot (design-decisions §18). So
  // the emphasis has to live on the label itself; there is nowhere else it is
  // allowed to go. Asserted on the CLASS rather than on a screenshot because
  // jsdom has no computed font weight to read.
  it('wears the unread emphasis on its own label, so a folded section keeps its activity tier', () => {
    const { rerender } = render(<SectionHeader label="Channels" collapsed onToggle={vi.fn()} />);
    const quiet = screen.getByRole('button', { name: 'Channels' });
    expect(quiet.className).toContain('text-sidebar-foreground/70');
    expect(quiet.className).not.toContain('font-semibold');

    rerender(<SectionHeader label="Channels" collapsed onToggle={vi.fn()} emphasized />);
    const loud = screen.getByRole('button', { name: 'Channels' });
    expect(loud.className).toContain('font-semibold');
    expect(loud.className).not.toContain('text-sidebar-foreground/70');
  });

  it('emphasises a header that cannot collapse too — Pinned is a label, not a button', () => {
    render(<SectionHeader label="Pinned" emphasized />);
    const label = screen.getByText('Pinned').parentElement;
    expect(label?.className).toContain('font-semibold');
  });
});
