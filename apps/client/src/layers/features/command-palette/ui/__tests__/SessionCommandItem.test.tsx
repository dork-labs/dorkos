// @vitest-environment jsdom
/**
 * ⌘K's conversation row, and the origin mark it wears (BC-26).
 *
 * BC-26 names ⌘K in the list of surfaces one registry serves, so the mark this
 * row draws is asserted to BE the registry's glyph rather than to merely exist:
 * an assertion that some SVG rendered would pass just as happily against a
 * local copy of the icon, which is the drift the registry was created to stop.
 *
 * @module features/command-palette/ui/__tests__/SessionCommandItem
 */
import React from 'react';
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Command, ORIGIN_GLYPH, TooltipProvider } from '@/layers/shared/ui';
import { SessionCommandItem } from '../SessionCommandItem';
import type { PaletteSessionItem } from '../../model/palette-sessions';

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
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function item(overrides: Partial<PaletteSessionItem> = {}): PaletteSessionItem {
  return {
    id: 'ses-1',
    who: 'tangerine',
    title: 'Wire the sidebar model',
    cwd: '/Users/dev/code/tangerine',
    agent: null,
    lastActivityAt: '2026-08-09T10:00:00.000Z',
    archived: false,
    ...overrides,
  };
}

function renderRow(row: PaletteSessionItem) {
  return render(
    <TooltipProvider>
      <Command>
        <SessionCommandItem item={row} onSelect={vi.fn()} />
      </Command>
    </TooltipProvider>
  );
}

/**
 * The shapes inside one glyph's `<svg>` — its geometry, which is what makes it
 * that glyph rather than another.
 *
 * The `<svg>` element's own attributes are deliberately not read: the row draws
 * its mark at 12px and the registry's default is 24, and a size is a rendering
 * choice while the geometry is the identity. Paths, lines and circles all count
 * — `#` is drawn with `<line>`s and would slip past a `path`-only reading.
 */
function geometry(root: Element | null): string | null {
  return root?.querySelector('svg')?.innerHTML ?? null;
}

describe('BC-26 — the origin mark comes from the one registry', () => {
  it.each(['task', 'room', 'agent', 'channel', 'external'] as const)(
    'draws the registry glyph for origin=%s',
    (origin) => {
      const { container } = renderRow(item({ origin }));
      const Glyph = ORIGIN_GLYPH[origin];
      const { container: registry } = render(<Glyph />);

      // The mark itself, not the whole row: the agent's avatar draws an icon of
      // its own a few pixels to the left.
      const drawn = geometry(container.querySelector('[aria-label^="Origin:"]'));
      expect(drawn).toBeTruthy();
      // Same geometry as the registry's own icon — a locally imported lucide
      // icon, or a second registry, would fail here rather than pass silently.
      expect(drawn).toEqual(geometry(registry));
    }
  );

  it('names the origin for a screen reader, not just for the eye', () => {
    const { getByLabelText } = renderRow(item({ origin: 'task' }));
    expect(getByLabelText('Origin: Scheduled task')).toBeInTheDocument();
  });

  it('prefers the session’s own wording when the server has better', () => {
    const { getByLabelText } = renderRow(item({ origin: 'channel', originLabel: 'Telegram' }));
    expect(getByLabelText('Origin: Telegram')).toBeInTheDocument();
  });

  it('marks nothing on an ordinary conversation — unmarked is you', () => {
    // The registry's `user` gap is the signal (§6). This is also why the mark
    // is invisible in Continue and Recent after DOR-1137: both lists are
    // human-origin only, so the surface that still draws marks is the typed
    // search, whose corpus keeps every automated run.
    const { container } = renderRow(item({ origin: 'user' }));
    expect(container.querySelector('[aria-label^="Origin:"]')).toBeNull();
  });
});
