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
 *
 * A {@link ShortcutDef.desktopOnly} shortcut is proved on the surface it claims,
 * with the desktop bridge installed — and then proved absent in a browser, both
 * from the panel's list and from the keyboard. The promise is per surface, so
 * the check is too.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { renderHook, render, cleanup } from '@testing-library/react';
import { SHORTCUTS, getShortcutsGrouped, type ShortcutDef } from '@/layers/shared/lib';
import { useRightPanelShortcut } from '@/layers/features/right-panel';
import { useProfileShortcut } from '@/layers/features/profile';
import { useAppTabShortcuts } from '@/layers/features/app-tabs';
import { useSessionPopoverShortcut } from '@/layers/features/status';
import { useNewSessionShortcut } from '@/layers/features/dashboard-sidebar';
import { SidebarProvider } from '@/layers/shared/ui';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';

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

afterEach(() => {
  cleanup();
  leaveDesktopShell();
});

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
    renderHook(() => useProfileShortcut());
    return press({ key: 'A', code: 'KeyA', metaKey: true, shiftKey: true });
  },
  'session-details': () => {
    renderHook(() => useSessionPopoverShortcut(() => {}));
    return press({ key: '.', code: 'Period', metaKey: true, shiftKey: true });
  },
  'new-session': () => {
    renderHook(() => useNewSessionShortcut(() => {}));
    return press({ key: 'n', code: 'KeyN', metaKey: true });
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
  // Registered only while something is actually waiting on a person — the
  // condition IS the design, because the chord otherwise belongs to the Profile
  // (see `SHORTCUTS.ANSWER_NEXT_ASK`). Proving it here would mean standing up a
  // query client, a transport and a seeded pending list, which is the whole
  // provider stack this file exists to avoid.
  'answer-next-ask': 'features/ask/model/use-ask-shortcut',
  // Opens the palette. Its hook pulls in the URL-backed dialog deep links, so
  // mounting it here would mean standing up the router as well.
  'command-palette': 'features/command-palette/model/use-global-palette',
  // Window-level, but registered with a text-input guard so it cannot fire
  // while you are typing a `?`.
  'shortcuts-panel': 'features/shortcuts/model/use-shortcuts-panel',
  // Registered by the sidebar footer strip — persistent chrome, which is what a
  // window-level shortcut needs — and only under `import.meta.env.DEV`. Proving
  // it here would mean standing up that component's provider stack (router,
  // transport, query client), so its `devOnly` flag is proved against the panel
  // listing below instead (DOR-567) — the handler keeps its own
  // `import.meta.env.DEV` guard as defense in depth.
  'dev-playground': 'features/dashboard-sidebar/ui/SidebarFooterStrip (dev only)',
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

  it.each(provable.map((s) => [s.id, s.key, s.label, s.desktopOnly === true] as const))(
    '%s (%s) — "%s"',
    (id, _key, _label, desktopOnly) => {
      // Prove it on the surface it claims. A desktop-only chord is not
      // registered in a browser by design, so firing it there would prove the
      // opposite of what this file is for.
      if (desktopOnly) enterDesktopShell();
      expect(PROVED[id]()).toBe(true);
    }
  );
});

describe('a desktop-only shortcut is neither listed nor live in a browser', () => {
  const desktopOnly = ALL.filter((shortcut) => shortcut.desktopOnly);

  it('has some — otherwise the cases below prove nothing', () => {
    expect(desktopOnly.length).toBeGreaterThan(0);
  });

  it.each(desktopOnly.map((s) => [s.id, s.key, s.label] as const))(
    '%s (%s) — "%s"',
    (id, _key, label) => {
      const listed = getShortcutsGrouped().flatMap((group) => group.shortcuts);
      expect(listed.map((s) => s.id)).not.toContain(id);

      // …and the panel is the surface a person reads, so check the label too:
      // a row that reappears under a different id is the same broken promise.
      expect(listed.map((s) => s.label)).not.toContain(label);

      // Nothing listening means nothing cancelled — the browser's own tab keys
      // reach the browser untouched.
      expect(PROVED[id]?.()).toBe(false);
    }
  );

  it('lists them again once the desktop bridge is there', () => {
    enterDesktopShell();
    const listed = getShortcutsGrouped().flatMap((group) => group.shortcuts);
    for (const shortcut of desktopOnly) {
      expect(listed.map((s) => s.id)).toContain(shortcut.id);
    }
  });
});

describe('a dev-only shortcut is not listed in a production build', () => {
  const devOnly = ALL.filter((shortcut) => shortcut.devOnly);

  it('has some — otherwise the cases below prove nothing', () => {
    expect(devOnly.length).toBeGreaterThan(0);
  });

  it.each(devOnly.map((s) => [s.id, s.key, s.label] as const))(
    '%s (%s) — "%s"',
    (id, _key, label) => {
      // vitest runs with import.meta.env.DEV === true by default, so the
      // production case has to be forced — same pattern used by
      // route-error-fallback.test.tsx, tabbed-dialog.test.tsx and
      // app-crash-fallback.test.tsx for this same env-dependent branch.
      const originalDev = import.meta.env.DEV;
      import.meta.env.DEV = false;
      try {
        const listed = getShortcutsGrouped().flatMap((group) => group.shortcuts);
        expect(listed.map((s) => s.id)).not.toContain(id);

        // …and the panel is the surface a person reads, so check the label
        // too: a row that reappears under a different id is the same broken
        // promise.
        expect(listed.map((s) => s.label)).not.toContain(label);
      } finally {
        import.meta.env.DEV = originalDev;
      }
    }
  );

  it('lists them again in a dev build', () => {
    // No override needed — this is the default vitest env.
    const listed = getShortcutsGrouped().flatMap((group) => group.shortcuts);
    for (const shortcut of devOnly) {
      expect(listed.map((s) => s.id)).toContain(shortcut.id);
    }
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
