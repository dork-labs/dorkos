// @vitest-environment jsdom
/**
 * The ⌘K pill (BC-46) — it opens the palette the rest of the app opens.
 *
 * Nothing is mocked here on purpose. The claim is "the same palette, not a
 * copy", and the only way to show that is to let the pill write the real
 * `globalPaletteOpen` flag — the one `DialogHost` mounts `GlobalCommandPalette`
 * on, and the one the ⌘K chord toggles. A mocked store would prove the pill
 * calls a function named like the real one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useAppStore } from '@/layers/shared/model';
import { SidebarSearchPill } from '../ui/SidebarSearchPill';

beforeEach(() => useAppStore.getState().setGlobalPaletteOpen(false));
afterEach(() => cleanup());

describe('SidebarSearchPill', () => {
  it('reads "Jump to anything…" and shows the chord that does the same thing', () => {
    render(<SidebarSearchPill />);
    const pill = screen.getByTestId('sidebar-search-pill');
    expect(pill).toHaveTextContent('Jump to anything…');
    expect(pill.textContent).toMatch(/K$/);
  });

  it('says nothing about a "workspace" — the sidebar speaks projects (§16, R4)', () => {
    render(<SidebarSearchPill />);
    expect(screen.getByTestId('sidebar-search-pill').textContent).not.toMatch(/workspace/i);
  });

  it('rides the sidebar tint ramp — never `--muted`, which flips between themes', () => {
    render(<SidebarSearchPill />);
    const html = screen.getByTestId('sidebar-search-pill').outerHTML;
    expect(html).toContain('bg-sidebar-accent');
    expect(html).not.toMatch(/\bbg-muted\b/);
  });

  it('opens the one global palette, through the flag the ⌘K chord itself flips', () => {
    render(<SidebarSearchPill />);
    // Observable before: the flag really is down, so the change below is the
    // pill's doing and not the store's default.
    expect(useAppStore.getState().globalPaletteOpen).toBe(false);

    fireEvent.click(screen.getByTestId('sidebar-search-pill'));

    expect(useAppStore.getState().globalPaletteOpen).toBe(true);
  });
});
