/**
 * @vitest-environment jsdom
 *
 * The signup panel behind an empty tile, driven through the section that owns
 * it rather than in isolation, so the wiring between the tile's press and the
 * dialog's state is part of what is checked.
 *
 * WHAT THIS FILE CANNOT SEE. jsdom reports every element as 0x0 and moves
 * focus for no key on its own, so nothing here says the panel is centred, that
 * it fits a 390px screen, or that a real Tab walks the browser's tab order.
 * What it can say is that the semantics are present and that the handlers this
 * component adds — the two ends of the trap, Escape, the outside press, and
 * the hand-back of focus — do what they claim. The geometry and the native tab
 * order were checked in a browser at 390x844 and 1440x900.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/analytics', () => ({ trackNewsletterSignup: vi.fn() }));

import { TUTORIALS } from '../tutorials';
import { TutorialsSection } from '../TutorialsSection';

/** The first tile with no clip behind it. The film's tile is not one of these. */
const PENDING = TUTORIALS.cards.find((card) => !card.clip);

/** The button that stands in for a clip that has not been shot. */
function pendingTile(): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(PENDING?.title ?? '', 'i') });
}

/** Everything a keyboard can land on inside the panel, in tab order. */
function stopsIn(dialog: HTMLElement): HTMLElement[] {
  return [
    ...dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  // motion reads both of these; jsdom ships neither.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    }
  );
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe('an empty tile is a press, not a dead frame', () => {
  it('gives every unshot tile a button and a name that explains the press', () => {
    render(<TutorialsSection config={TUTORIALS} />);
    const tile = pendingTile();
    // Title, then the honest state, then what pressing does. A screen reader
    // gets no hover, so the last part has to be in the name.
    expect(tile.getAttribute('aria-label')).toContain(PENDING?.title);
    expect(tile.getAttribute('aria-label')).toContain(TUTORIALS.pendingChip);
    expect(tile.getAttribute('aria-label')).toContain(TUTORIALS.alert.triggerHint);
  });

  it('opens a labelled modal dialog on press', () => {
    render(<TutorialsSection config={TUTORIALS} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(pendingTile());

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The accessible name is the tile's title plus the panel's heading, so the
    // announcement says which tile this is about.
    const name = (dialog.getAttribute('aria-labelledby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(name).toContain(PENDING?.title);
    expect(name).toContain(TUTORIALS.alert.title);
    const described = document.getElementById(dialog.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe(TUTORIALS.alert.lede);
  });

  it('moves focus into the panel and hands it back to the tile that opened it', () => {
    render(<TutorialsSection config={TUTORIALS} />);
    const tile = pendingTile();
    fireEvent.click(tile);

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement) || document.activeElement === dialog).toBe(true);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(tile);
  });

  it('still closes on Escape after focus has been dropped on the floor', () => {
    // The regression a browser pass caught. The signup button disables itself
    // while the request is in flight, a disabled element cannot hold focus, so
    // focus lands on `<body>` — and a handler on the panel never sees another
    // key. Escape stopped working right after the one interaction the panel
    // exists for. `blur()` reproduces the state that leaves the page in.
    render(<TutorialsSection config={TUTORIALS} />);
    const tile = pendingTile();
    fireEvent.click(tile);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(tile);
  });

  it('pulls Tab back inside after focus has been dropped', () => {
    render(<TutorialsSection config={TUTORIALS} />);
    fireEvent.click(pendingTile());
    const dialog = screen.getByRole('dialog');
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: 'Tab' });

    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(stopsIn(dialog)[0]);
  });

  it('closes on the button in its corner', () => {
    render(<TutorialsSection config={TUTORIALS} />);
    fireEvent.click(pendingTile());
    fireEvent.click(screen.getByRole('button', { name: TUTORIALS.alert.close }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on a press outside it, and not on one inside', () => {
    render(<TutorialsSection config={TUTORIALS} />);
    fireEvent.click(pendingTile());

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    expect(screen.queryByRole('dialog'), 'a press inside the panel closed it').not.toBeNull();

    const overlay = dialog.parentElement;
    fireEvent.mouseDown(overlay ?? document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps Tab inside the panel at both ends', () => {
    // jsdom does not move focus on Tab by itself, so what is observable here
    // is exactly the part this component adds: the wrap at each end.
    render(<TutorialsSection config={TUTORIALS} />);
    fireEvent.click(pendingTile());
    const dialog = screen.getByRole('dialog');
    const stops = stopsIn(dialog);
    expect(stops.length).toBeGreaterThan(1);
    const first = stops[0];
    const last = stops[stops.length - 1];

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('subscribes through the site’s one newsletter pathway', async () => {
    render(<TutorialsSection config={TUTORIALS} />);
    fireEvent.click(pendingTile());

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'kai@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));

    await waitFor(() => expect(screen.getByText(/check your inbox/i)).toBeTruthy());
    // The same endpoint the footer's box posts to. A second pathway would be a
    // second list to keep and a second unsubscribe to honour.
    expect(fetch).toHaveBeenCalledWith(
      '/api/newsletter/subscribe',
      expect.objectContaining({ method: 'POST' })
    );
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({ email: 'kai@example.com' });
  });

  it('leaves the pending chip on the tile, panel or no panel', () => {
    // The offer must not replace the admission. A tile that swaps "clip
    // coming" for a mailing-list pitch is a tile that stopped being honest.
    render(<TutorialsSection config={TUTORIALS} />);
    const chips = screen.getAllByText(TUTORIALS.pendingChip);
    expect(chips.length).toBe(TUTORIALS.cards.filter((card) => !card.clip).length);
  });
});
