// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useAppStore, useThemeStore } from '@/layers/shared/model';
import { FONT_CONFIGS } from '@/layers/shared/lib';
import { AppearanceTab } from '../ui/tabs/AppearanceTab';

beforeAll(() => {
  // Radix Select needs DOM APIs jsdom lacks to open its listbox under userEvent
  // — the same shims EffortRow's tests install for the same control.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  if (!proto.scrollIntoView) proto.scrollIntoView = vi.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('AppearanceTab', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().resetAllSettings();
    useThemeStore.getState().setTheme('system');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // The font-family trigger is the second of three comboboxes on this tab
  // (theme, font family, font size) — fixed by AppearanceTab's own layout, so
  // position is a stable way to reach it. None of the three carries an
  // accessible name of its own; `SelectValue` renders the selected item's
  // content as-is rather than a label.
  function openFontFamilyMenu() {
    const [, fontFamilyTrigger] = screen.getAllByRole('combobox');
    return userEvent.click(fontFamilyTrigger);
  }

  it('offers every configured font by name in the font-family menu', async () => {
    render(<AppearanceTab />);

    await openFontFamilyMenu();

    for (const font of FONT_CONFIGS) {
      expect(screen.getByRole('option', { name: new RegExp(font.displayName) })).toBeVisible();
    }
  });

  it('ellipsises a font description that outgrows the trigger instead of hard-clipping it (DOR-1747)', async () => {
    // Settings → Appearance showed "Inter + JetBrains Mor" — the trigger is
    // narrower than the description and, with nothing to truncate it, the
    // browser cut the text mid-character. `truncate` is what turns that back
    // into a choice ("Inter + JetBrains M…") instead of a rendering fault.
    // jsdom lays out no pixels, so this pins the class that produces the
    // ellipsis rather than the ellipsis itself — the pixel measurement is a
    // browser-only guarantee, verified separately.
    render(<AppearanceTab />);

    await openFontFamilyMenu();

    const inter = FONT_CONFIGS.find((f) => f.key === 'inter')!;
    const description = screen.getAllByText(inter.description).at(-1)!;
    expect(description).toHaveClass('truncate');
    // The flex column has to give up its own width for `truncate` to have
    // anything to clip against — `min-w-0` overrides the flex-item default
    // that would otherwise let the column grow to fit the text instead.
    expect(description.parentElement).toHaveClass('min-w-0');
  });
});
