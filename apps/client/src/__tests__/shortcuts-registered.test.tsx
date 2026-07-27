/**
 * @vitest-environment jsdom
 *
 * The shortcuts panel is a promise. Every combo it lists must actually do
 * something, and this file is the gate that keeps that true.
 *
 * The panel renders {@link SHORTCUTS} verbatim, so a shortcut declared there and
 * listened for nowhere is a lie told straight to the operator — one that costs
 * nothing to write and is invisible in review. Three such shortcuts were deleted
 * a few PRs ago; `NEW_SESSION` (`mod+shift+n`) was a fourth, declared, rendered
 * in the panel, printed as a `Kbd` on the embed's New button, and wired to no
 * handler at all. One-off cleanups do not stop that recurring, so the registry
 * is now checked against reality on every run.
 *
 * Two tiers, because two tiers is what is honestly provable:
 *
 * - **{@link PROVED}** — window-level chords. The test mounts the smallest thing
 *   that registers each one and fires the real keystroke. Nothing calls
 *   `preventDefault` means nothing is listening, and the test fails.
 * - **{@link DECLARED}** — keys that only exist inside a focused surface (the
 *   composer, a tool approval, an open overlay) or inside a component that needs
 *   the whole app around it. Proving those would mean rebuilding those surfaces
 *   here, so each is listed with the module that owns it instead. A weaker
 *   claim, deliberately made explicit.
 *
 * Neither list may drift: a shortcut in neither one fails
 * `accounts for every shortcut`, and an entry in either that names a shortcut
 * the registry no longer has fails the stale-entry tests. So adding a shortcut
 * forces you to either prove it or name its owner, and deleting one forces the
 * cleanup.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { renderHook, render, cleanup } from '@testing-library/react';
import { SHORTCUTS, type ShortcutDef } from '@/layers/shared/lib';
import { useRightPanelShortcut, useAgentProfileShortcut } from '@/layers/features/right-panel';
import { useAppTabShortcuts } from '@/layers/features/app-tabs';
import { useSessionPopoverShortcut } from '@/layers/features/status';
import { SidebarProvider } from '@/layers/shared/ui';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn((_options: { href: string }) => Promise.resolve()),
  useRouter: () => ({
    navigate: (_options: { href: string }) => Promise.resolve(),
    state: { location: { href: '/' } },
  }),
}));

beforeAll(() => {
  // SidebarProvider reads the viewport through useIsMobile.
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
});

afterEach(cleanup);

/** Fire a chord the way a keyboard would, and report whether anything took it. */
function press(init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Mounts a shortcut's owner, fires its keystroke, and reports whether it landed. */
type Prover = () => boolean;

/** Window-level chords, each with the smallest mount that registers it. */
const PROVED: Record<string, Prover> = {
  'toggle-sidebar': () => {
    // Registered by SidebarProvider itself, not by a standalone hook.
    render(<SidebarProvider>sidebar</SidebarProvider>);
    return press({ key: 'b', code: 'KeyB', metaKey: true });
  },
  'toggle-right-panel': () => {
    renderHook(() => useRightPanelShortcut());
    return press({ key: '.', code: 'Period', metaKey: true });
  },
  'agent-profile': () => {
    renderHook(() => useAgentProfileShortcut());
    return press({ key: 'A', code: 'KeyA', metaKey: true, shiftKey: true });
  },
  'session-details': () => {
    renderHook(() => useSessionPopoverShortcut(() => {}));
    return press({ key: '.', code: 'Period', metaKey: true, shiftKey: true });
  },
  'new-tab': () => {
    renderHook(() => useAppTabShortcuts());
    return press({ key: 't', code: 'KeyT', metaKey: true });
  },
  'select-tab': () => {
    renderHook(() => useAppTabShortcuts());
    return press({ key: '1', code: 'Digit1', metaKey: true });
  },
  'previous-tab': () => {
    renderHook(() => useAppTabShortcuts());
    return press({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true });
  },
  'next-tab': () => {
    renderHook(() => useAppTabShortcuts());
    return press({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
  },
};

/** Shortcuts listed with the module that registers them, not fired here. */
const DECLARED: Record<string, string> = {
  // Opens the palette. Its hook pulls in the URL-backed dialog deep links, so
  // mounting it here would mean standing up the router as well.
  'command-palette': 'features/command-palette/model/use-global-palette',
  // Window-level, but registered with a text-input guard so it cannot fire
  // while you are typing a `?`.
  'shortcuts-panel': 'features/shortcuts/model/use-shortcuts-panel',
  // Registered by SidebarFooterBar, and only under `import.meta.env.DEV` — it
  // does not exist in a production build.
  'dev-playground': 'features/session-list/ui/SidebarFooterBar (dev only)',
  // Composer keys — the chat composer's own `onKeyDown`.
  'new-line': 'features/chat composer',
  'new-line-alt': 'features/chat composer',
  'line-continuation': 'features/chat composer',
  'clear-message': 'features/chat composer',
  'stop-streaming': 'features/chat composer',
  // Tool-approval and question keys.
  'approve-tool': 'shared/model/use-interactive-shortcuts',
  'deny-tool': 'shared/model/use-interactive-shortcuts',
  'toggle-option': 'shared/model/use-interactive-shortcuts',
  'submit-answer': 'shared/model/use-interactive-shortcuts',
  // Dismissal belongs to whichever Radix overlay has focus.
  'close-overlay': 'shared/ui overlays (Radix)',
};

const ALL: ShortcutDef[] = Object.values(SHORTCUTS);

describe('shortcuts the panel advertises are really registered', () => {
  const provable = ALL.filter((shortcut) => PROVED[shortcut.id]);

  it.each(provable.map((s) => [s.id, s.key, s.label] as const))('%s (%s) — "%s"', (id) => {
    expect(PROVED[id]()).toBe(true);
  });
});

describe('the registry cannot grow an unverified entry', () => {
  it('accounts for every shortcut, by proof or by named owner', () => {
    const unaccounted = ALL.filter(
      (shortcut) => !PROVED[shortcut.id] && !DECLARED[shortcut.id]
    ).map((shortcut) => `${shortcut.id} (${shortcut.key})`);

    // A new shortcut lands here. Add a prover to PROVED if it is a window-level
    // chord, or an owner to DECLARED if it belongs to a focused surface — and
    // if you can do neither, the shortcut does not exist and does not belong in
    // the panel.
    expect(unaccounted).toEqual([]);
  });

  it('keeps no prover for a shortcut the registry no longer has', () => {
    const stale = Object.keys(PROVED).filter((id) => !ALL.some((s) => s.id === id));
    expect(stale).toEqual([]);
  });

  it('keeps no declared owner for a shortcut the registry no longer has', () => {
    const stale = Object.keys(DECLARED).filter((id) => !ALL.some((s) => s.id === id));
    expect(stale).toEqual([]);
  });
});
